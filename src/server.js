import { readFileSync, writeFileSync, renameSync, appendFileSync, statSync } from "fs"
import { join } from "path"
import { resolveBudgetDir, resolveReadFile, resolveWriteFile } from "./budget-file.js"

const DEBUG_FILE = join(resolveBudgetDir(), "budget-debug.log")

const DEBUG = process.env.OPENCODE_BUDGET_DEBUG === "1"
const DEBUG_MAX_BYTES = 1024 * 1024
const FALLBACK_DEFAULT = Number(process.env.OPENCODE_BUDGET_DEFAULT) || 1
const PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000
const UNLIMITED = Infinity

/** Fractions of the limit that trigger a one-off heads-up toast. */
const WARN_AT = (process.env.OPENCODE_BUDGET_WARN ?? "0.5,0.8,0.95")
  .split(",")
  .map((v) => Number.parseFloat(v))
  .filter((v) => Number.isFinite(v) && v > 0 && v < 1)
  .sort((a, b) => a - b)

const USAGE = "Usage: /budget [ <amount> | +<amount> | off | reset ]"

function dbg(...args) {
  if (!DEBUG) return
  try {
    resolveWriteFile() // ensures the data directory exists
    try {
      if (statSync(DEBUG_FILE).size > DEBUG_MAX_BYTES) renameSync(DEBUG_FILE, `${DEBUG_FILE}.1`)
    } catch {}
    appendFileSync(DEBUG_FILE, `${new Date().toISOString()} ${args.join(" ")}\n`)
  } catch {}
}

/**
 * Store shape (v2):
 * { "version": 2, "default": 1, "sessions": { "<id>": { "limit": 3, "updatedAt": 1700000000000 } } }
 * v1 (flat { "<id>": number }) is migrated on load.
 */
export function loadStore() {
  let raw
  try {
    raw = JSON.parse(readFileSync(resolveReadFile(), "utf8"))
  } catch {
    return { version: 2, default: FALLBACK_DEFAULT, sessions: {} }
  }
  if (raw && raw.version === 2) {
    return {
      version: 2,
      default: typeof raw.default === "number" ? raw.default : FALLBACK_DEFAULT,
      sessions: raw.sessions ?? {},
    }
  }
  const now = Date.now()
  const sessions = {}
  for (const [id, limit] of Object.entries(raw ?? {})) {
    if (typeof limit === "number") sessions[id] = { limit, updatedAt: now }
  }
  return { version: 2, default: FALLBACK_DEFAULT, sessions }
}

export function saveStore(store) {
  const cutoff = Date.now() - PRUNE_AFTER_MS
  for (const [id, entry] of Object.entries(store.sessions)) {
    if ((entry.updatedAt ?? 0) < cutoff) delete store.sessions[id]
  }
  try {
    const file = resolveWriteFile()
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(store, null, 2))
    renameSync(tmp, file)
  } catch (e) {
    dbg("[budget] saveStore error:", e?.message)
  }
}

const serialize = (limit) => (limit === UNLIMITED ? "unlimited" : limit)
const deserialize = (limit) => (limit === "unlimited" || limit === null ? UNLIMITED : limit)
const fmt = (amount) => (amount === UNLIMITED ? "unlimited" : `$${amount.toFixed(2)}`)

export const BudgetPlugin = async ({ client, directory }) => {
  const store = loadStore()
  saveStore(store) // persist migration / prune once at startup

  /** @type {Map<string, Map<string, number>>} rootID -> messageID -> cost */
  const costs = new Map()
  /** @type {Map<string, Promise<string>>} sessionID -> rootID */
  const rootCache = new Map()
  /** @type {Map<string, Promise<void>>} rootID -> in-flight backfill */
  const backfills = new Map()
  /** @type {Set<string>} roots already toasted for being over budget */
  const notified = new Set()
  /** @type {Map<string, number>} rootID -> highest warning fraction already shown */
  const warned = new Map()
  /** @type {Set<string>} sessions whose run we killed, i.e. work left unfinished */
  const interrupted = new Set()

  async function toast(message, variant, duration = 6000) {
    await client.tui.showToast({ body: { title: "Budget", message, variant, duration } }).catch(() => {})
  }

  /** Walk parentID chain so sub-agent sessions bill to the session the user sees. */
  async function rootOf(sessionID) {
    const cached = rootCache.get(sessionID)
    if (cached) return cached
    const pending = (async () => {
      let current = sessionID
      for (let depth = 0; depth < 10; depth++) {
        try {
          const { data } = await client.session.get({ path: { id: current } })
          if (!data?.parentID) return current
          current = data.parentID
        } catch (e) {
          dbg("[budget] rootOf error:", e?.message)
          return current
        }
      }
      return current
    })()
    rootCache.set(sessionID, pending)
    return pending
  }

  function costMap(rootID) {
    let map = costs.get(rootID)
    if (!map) costs.set(rootID, (map = new Map()))
    return map
  }

  function spentOn(rootID) {
    let total = 0
    for (const cost of costMap(rootID).values()) total += cost
    return total
  }

  function limitOf(rootID) {
    const entry = store.sessions[rootID]
    return entry ? deserialize(entry.limit) : store.default
  }

  function setLimit(rootID, limit) {
    const entry = store.sessions[rootID] ?? {}
    store.sessions[rootID] = { ...entry, limit: serialize(limit), updatedAt: Date.now() }
    saveStore(store)
  }

  /** Persisted so a restart between the abort and the raise does not lose it. */
  function markInterrupted(rootID, value) {
    const entry = store.sessions[rootID]
    if (!entry && !value) return
    store.sessions[rootID] = {
      limit: entry?.limit ?? serialize(store.default),
      updatedAt: Date.now(),
      ...(value ? { interrupted: true } : {}),
    }
    saveStore(store)
  }

  function wasInterruptedBefore(rootID) {
    return store.sessions[rootID]?.interrupted === true
  }

  /** Backfill historic costs once per root (deduped by promise, not by flag, to avoid races). */
  async function backfill(rootID) {
    const inflight = backfills.get(rootID)
    if (inflight) return inflight
    const pending = (async () => {
      const ids = [rootID]
      try {
        const { data } = await client.session.children({ path: { id: rootID } })
        for (const child of data ?? []) ids.push(child.id)
      } catch (e) {
        dbg("[budget] children error:", e?.message)
      }
      const map = costMap(rootID)
      for (const id of ids) {
        try {
          const { data } = await client.session.messages({ path: { id }, query: { limit: 10000 } })
          for (const { info } of data ?? []) {
            if (info.role === "assistant" && info.cost > 0) map.set(info.id, info.cost)
          }
        } catch (e) {
          dbg("[budget] messages error:", id, e?.message)
        }
      }
      dbg("[budget] backfilled", rootID, "spent:", spentOn(rootID).toFixed(4))
    })()
    backfills.set(rootID, pending)
    return pending
  }

  function statusLine(rootID) {
    const spent = spentOn(rootID)
    const limit = limitOf(rootID)
    if (limit === UNLIMITED) return `${fmt(spent)} spent, no limit set.`
    const pct = Math.round((spent / limit) * 100)
    const bar = "█".repeat(Math.min(10, Math.round(pct / 10))).padEnd(10, "░")
    return `${bar} ${pct}% — ${fmt(spent)} of ${fmt(limit)}, ${fmt(Math.max(0, limit - spent))} left.`
  }

  /** Toast once per threshold crossed, so spend is visible before it hard-stops. */
  async function warnIfNearLimit(rootID, spent, limit) {
    const ratio = spent / limit
    const already = warned.get(rootID) ?? 0
    const crossed = WARN_AT.filter((t) => ratio >= t && t > already).pop()
    if (!crossed) return
    warned.set(rootID, crossed)
    await toast(statusLine(rootID), crossed >= 0.9 ? "warning" : "info", 8000)
  }

  /** Stop an in-flight run that has already blown past the limit mid-turn. */
  async function enforceRunning(rootID, sessionID) {
    const limit = limitOf(rootID)
    if (limit === UNLIMITED) return
    const spent = spentOn(rootID)
    if (spent < limit) {
      await warnIfNearLimit(rootID, spent, limit)
      return
    }
    for (const id of new Set([sessionID, rootID])) {
      await client.session.abort({ path: { id } }).catch(() => {})
    }
    // The run died mid-task, so raising the limit should offer to pick it up.
    interrupted.add(rootID)
    markInterrupted(rootID, true)
    if (!notified.has(rootID)) {
      notified.add(rootID)
      await toast(`Limit reached: ${fmt(spent)} of ${fmt(limit)}. Raise it with /budget <amount>.`, "warning", 30000)
    }
  }

  /**
   * Cancel the run that is about to start. Hooks cannot reject a send (throwing
   * surfaces as "Unexpected server error"), so the turn is aborted instead —
   * the request is killed on the spot and the TUI shows a normal cancellation.
   * Retried briefly because the run may not be registered yet when we fire.
   */
  function cancelRun(sessionID) {
    for (const delay of [0, 80, 250, 600]) {
      setTimeout(() => {
        client.session.abort({ path: { id: sessionID } }).catch(() => {})
      }, delay)
    }
  }

  async function runCommand(sessionID, rawArg) {
    const rootID = await rootOf(sessionID)
    const arg = (rawArg ?? "").trim().toLowerCase() || null
    await backfill(rootID)

    const previous = limitOf(rootID)
    const spent = spentOn(rootID)

    if (!arg) {
      await toast(`${statusLine(rootID)} ${USAGE}`, "info", 10000)
      return
    }

    let next
    if (arg === "off" || arg === "unlimited") {
      next = UNLIMITED
    } else if (arg === "reset") {
      delete store.sessions[rootID]
      saveStore(store)
      next = store.default
    } else {
      const relative = arg.startsWith("+")
      const amount = Number.parseFloat(relative ? arg.slice(1) : arg)
      if (!Number.isFinite(amount) || amount <= 0) {
        await toast(`Invalid amount "${arg}". ${USAGE}`, "error")
        return
      }
      next = relative ? (previous === UNLIMITED ? UNLIMITED : previous + amount) : amount
    }

    if (arg !== "reset") setLimit(rootID, next)
    notified.delete(rootID)
    warned.delete(rootID)

    const unblocked = previous !== UNLIMITED && spent >= previous && (next === UNLIMITED || spent < next)
    const wasInterrupted = unblocked && (interrupted.delete(rootID) || wasInterruptedBefore(rootID))
    if (wasInterrupted) markInterrupted(rootID, false)

    // An aborted run cannot be restarted through the API — only a fresh prompt
    // continues it. Rather than inventing a turn, drop the word into the prompt
    // box so the decision (and the wording) stays with the user.
    // Deferred: the TUI clears the prompt after a command runs, which would
    // wipe the text if it were appended synchronously.
    if (wasInterrupted) {
      setTimeout(() => {
        client.tui
          .appendPrompt({ body: { text: "continue" }, query: directory ? { directory } : undefined })
          .then((r) => dbg("[budget] appendPrompt ok:", JSON.stringify(r?.data ?? r?.error ?? null)))
          .catch((e) => dbg("[budget] appendPrompt error:", e?.message))
      }, 400)
    }

    await toast(
      `Limit ${fmt(next)}, ${fmt(spent)} spent.${wasInterrupted ? " Press enter to continue the interrupted run." : ""}`,
      "success",
    )
    dbg("[budget] limit set", rootID, serialize(next), "interrupted:", wasInterrupted)
  }

  return {
    /**
     * Real slash command (see commands/budget.md). Handled locally; the run it
     * would have triggered is cancelled immediately.
     */
    "command.execute.before": async (input, output) => {
      if (input.command !== "budget") return
      output.parts = []
      cancelRun(input.sessionID)
      await runCommand(input.sessionID, input.arguments)
    },

    /**
     * Gate the turn before any tokens are spent. The payload is never rewritten
     * (that produced malformed conversations); the run is cancelled instead.
     */
    "chat.message": async (input) => {
      const rootID = await rootOf(input.sessionID)
      await backfill(rootID)
      const limit = limitOf(rootID)
      if (limit === UNLIMITED) return
      const spent = spentOn(rootID)
      if (spent < limit) {
        await warnIfNearLimit(rootID, spent, limit)
        return
      }
      cancelRun(input.sessionID)
      if (!notified.has(rootID)) {
        notified.add(rootID)
        await toast(
          `Limit reached: ${fmt(spent)} of ${fmt(limit)}. Raise it with /budget <amount>, or /budget off.`,
          "warning",
          30000,
        )
      }
      dbg("[budget] cancelled turn on", input.sessionID)
    },

    event: async ({ event }) => {
      if (event.type === "session.deleted") {
        const id = event.properties?.info?.id
        if (id && store.sessions[id]) {
          delete store.sessions[id]
          saveStore(store)
        }
        costs.delete(id)
        rootCache.delete(id)
        backfills.delete(id)
        notified.delete(id)
        warned.delete(id)
        interrupted.delete(id)
        return
      }

      if (event.type !== "message.updated") return
      const { info } = event.properties
      if (info.role !== "assistant" || !(info.cost > 0)) return

      const rootID = await rootOf(info.sessionID)
      await backfill(rootID)
      costMap(rootID).set(info.id, info.cost)
      await enforceRunning(rootID, info.sessionID)
    },
  }
}

export default { id: "budget-limit", server: BudgetPlugin }
