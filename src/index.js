import { readFileSync, writeFileSync, renameSync, appendFileSync, statSync } from "fs"
import { join } from "path"
import { Plugin } from "@opencode/plugin"
import { resolveBudgetDir, resolveReadFile, resolveWriteFile, resolveSpendFile } from "./budget-file.js"

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

/**
 * Spend cache, published for the sidebar.
 *
 * The sidebar cannot compute this itself: the TUI state API exposes sessions
 * one id at a time, with no way to enumerate the sub-agent sessions a run
 * spawned. Summing only the visible session is what the host's own Context
 * block does — which is why Context reads lower than the limit does whenever
 * sub-agents ran, and why a sidebar built on the same number would show a
 * half-empty bar while the run was being cut off.
 */
function loadSpend() {
  try {
    const raw = JSON.parse(readFileSync(resolveSpendFile(), "utf8"))
    if (raw?.version === 1 && raw.sessions) return raw
  } catch {}
  return { version: 1, sessions: {} }
}

function saveSpend(spend) {
  const cutoff = Date.now() - PRUNE_AFTER_MS
  for (const [id, entry] of Object.entries(spend.sessions)) {
    if ((entry.updatedAt ?? 0) < cutoff) delete spend.sessions[id]
  }
  try {
    resolveWriteFile() // ensures the data directory exists
    const file = resolveSpendFile()
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(spend, null, 2))
    renameSync(tmp, file)
  } catch (e) {
    dbg("[budget] saveSpend error:", e?.message)
  }
}

/**
 * OpenCode loads one plugin instance per project location, so several copies
 * of this module share the same files. Each write therefore re-reads the file
 * and changes only its own entries; saving a whole in-memory copy would put
 * back limits another instance had just changed.
 */
function updateStore(change) {
  const store = loadStore()
  change(store)
  saveStore(store)
  return store
}

function updateSpend(change) {
  const spend = loadSpend()
  change(spend)
  saveSpend(spend)
}

const serialize = (limit) => (limit === UNLIMITED ? "unlimited" : limit)
const deserialize = (limit) => (limit === "unlimited" || limit === null ? UNLIMITED : limit)
const fmt = (amount) => (amount === UNLIMITED ? "unlimited" : `$${amount.toFixed(2)}`)

export default Plugin.define({
  id: "budget-limit",
  async setup(ctx) {
    saveStore(loadStore()) // persist migration / prune once at startup

    /** @type {Map<string, ReturnType<typeof setTimeout>>} rootID -> pending publish */
    const publishTimers = new Map()
    /** @type {Set<string>} roots whose total includes sub-agent spend */
    const subagents = new Set()
    /** @type {Map<string, Set<string>>} rootID -> every session id billing to it */
    const branch = new Map()

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

    /**
     * There is no toast API on the server plugin context — toasts are a CLI
     * (local TUI) concept, and the server can be driving a headless or remote
     * client. A synthetic message is the closest server-side equivalent: it
     * shows up in the session transcript regardless of which client is attached.
     */
    async function notify(sessionID, message) {
      // resume: false keeps the note in the transcript without waking the agent.
      await ctx.session.synthetic({ sessionID, text: `[Budget] ${message}`, resume: false }).catch((e) => {
        dbg("[budget] notify error:", e?.message)
      })
    }

    /** Walk parentID chain so sub-agent sessions bill to the session the user sees. */
    async function rootOf(sessionID) {
      const cached = rootCache.get(sessionID)
      if (cached) return cached
      const pending = (async () => {
        let current = sessionID
        for (let depth = 0; depth < 10; depth++) {
          try {
            const info = await ctx.session.get({ sessionID: current })
            if (!info?.parentID) return current
            current = info.parentID
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

    /** rootID -> sessionID -> that session's own total cost, as opencode reports it. */
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

    /**
     * Publish the running total for the sidebar. Coalesced: costs arrive per
     * assistant message, and a turn produces many, so writing on each one would
     * churn the file for no visible gain.
     */
    function publishSpent(rootID) {
      if (publishTimers.has(rootID)) return
      publishTimers.set(
        rootID,
        setTimeout(() => {
          publishTimers.delete(rootID)
          const entry = {
            spent: spentOn(rootID),
            subagents: subagents.has(rootID),
            updatedAt: Date.now(),
          }
          // Published under every id in the branch, not just the root, so a
          // sidebar opened on a sub-agent session reports the budget that
          // actually governs it rather than falling back to nothing.
          updateSpend((spend) => {
            for (const id of branch.get(rootID) ?? [rootID]) spend.sessions[id] = entry
          })
        }, 300),
      )
    }

    /** Read from disk every time: another instance may have changed it. */
    function limitOf(rootID) {
      const store = loadStore()
      const entry = store.sessions[rootID]
      return entry ? deserialize(entry.limit) : store.default
    }

    function setLimit(rootID, limit) {
      updateStore((store) => {
        const entry = store.sessions[rootID] ?? {}
        store.sessions[rootID] = { ...entry, limit: serialize(limit), updatedAt: Date.now() }
      })
    }

    /** Persisted so a restart between the abort and the raise does not lose it. */
    function markInterrupted(rootID, value) {
      updateStore((store) => {
        const entry = store.sessions[rootID]
        if (!entry && !value) return
        store.sessions[rootID] = {
          limit: entry?.limit ?? serialize(store.default),
          updatedAt: Date.now(),
          ...(value ? { interrupted: true } : {}),
        }
      })
    }

    function wasInterruptedBefore(rootID) {
      return loadStore().sessions[rootID]?.interrupted === true
    }

    /**
     * Costs are read from the session itself, never summed from events: a
     * single message emits several `session.usage.updated` events, so adding
     * them up counted the same spend many times over.
     */
    async function refreshCost(rootID, sessionID) {
      try {
        const info = await ctx.session.get({ sessionID })
        if (typeof info?.cost === "number") costMap(rootID).set(sessionID, info.cost)
      } catch (e) {
        dbg("[budget] cost refresh error:", sessionID, e?.message)
      }
    }

    /**
     * Load the root's own cost once per root (deduped by promise, not by flag,
     * to avoid races).
     *
     * V2 has no session-children listing in the plugin context (V1's
     * `client.session.children` has no equivalent here), so only the root is
     * known up front. Sub-agent sessions join the branch live from
     * `session.forked` / `session.usage.updated` events in the main event loop
     * below; a sub-agent that spent before this plugin instance started is not
     * retroactively counted.
     */
    async function backfill(rootID) {
      const inflight = backfills.get(rootID)
      if (inflight) return inflight
      const pending = (async () => {
        await refreshCost(rootID, rootID)
        dbg("[budget] backfilled", rootID, "spent:", spentOn(rootID).toFixed(4))
        publishSpent(rootID)
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

    /** Message once per threshold crossed, so spend is visible before it hard-stops. */
    async function warnIfNearLimit(rootID, spent, limit) {
      const ratio = spent / limit
      const already = warned.get(rootID) ?? 0
      const crossed = WARN_AT.filter((t) => ratio >= t && t > already).pop()
      if (!crossed) return
      warned.set(rootID, crossed)
      await notify(rootID, statusLine(rootID))
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
        await ctx.session.interrupt({ sessionID: id, continue: false }).catch(() => {})
      }
      // The run died mid-task, so raising the limit should offer to pick it up.
      interrupted.add(rootID)
      markInterrupted(rootID, true)
      if (!notified.has(rootID)) {
        notified.add(rootID)
        await notify(rootID, `Limit reached: ${fmt(spent)} of ${fmt(limit)}. Raise it with /budget <amount>.`)
      }
    }

    async function runCommand(sessionID, rawArg) {
      const rootID = await rootOf(sessionID)
      const arg = (rawArg ?? "").trim().toLowerCase() || null
      await backfill(rootID)

      const previous = limitOf(rootID)
      const spent = spentOn(rootID)

      if (!arg) {
        await notify(sessionID, `${statusLine(rootID)} ${USAGE}`)
        return
      }

      let next
      if (arg === "off" || arg === "unlimited") {
        next = UNLIMITED
      } else if (arg === "reset") {
        next = updateStore((store) => delete store.sessions[rootID]).default
      } else {
        const relative = arg.startsWith("+")
        const amount = Number.parseFloat(relative ? arg.slice(1) : arg)
        if (!Number.isFinite(amount) || amount <= 0) {
          await notify(sessionID, `Invalid amount "${arg}". ${USAGE}`)
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
      if (wasInterrupted) {
        setTimeout(() => {
          ctx.session
            .prompt({ sessionID, text: "continue" })
            .then((r) => dbg("[budget] continue prompt ok:", JSON.stringify(r ?? null)))
            .catch((e) => dbg("[budget] continue prompt error:", e?.message))
        }, 400)
      }

      await notify(
        sessionID,
        `Limit ${fmt(next)}, ${fmt(spent)} spent.${wasInterrupted ? " Press enter to continue the interrupted run." : ""}`,
      )
      dbg("[budget] limit set", rootID, serialize(next), "interrupted:", wasInterrupted)
    }

    /** Real slash command. The plugin owns it; no separate commands/budget.md file is needed. */
    await ctx.command.transform((editor) => {
      editor.add({
        name: "budget",
        description: "Show or change the spend limit for this session",
        execute: async ({ sessionID, prompt }) => {
          await runCommand(sessionID, prompt.text)
        },
      })
    })

    /**
     * Gate the next turn before any tokens are spent. There is no rejection API
     * for prompt admission (see the prompt hook docs), so an over-budget turn
     * is interrupted immediately after it is admitted instead — the same
     * workaround the V1 implementation used via `client.session.abort`.
     */
    await ctx.session.hook("context", async (event) => {
      const rootID = await rootOf(event.sessionID)
      await backfill(rootID)
      const limit = limitOf(rootID)
      if (limit === UNLIMITED) return
      const spent = spentOn(rootID)
      if (spent < limit) {
        await warnIfNearLimit(rootID, spent, limit)
        return
      }
      await ctx.session.interrupt({ sessionID: event.sessionID, continue: false }).catch(() => {})
      if (!notified.has(rootID)) {
        notified.add(rootID)
        await notify(
          event.sessionID,
          `Limit reached: ${fmt(spent)} of ${fmt(limit)}. Raise it with /budget <amount>, or /budget off.`,
        )
      }
      dbg("[budget] cancelled turn on", event.sessionID)
    })

    const controller = new AbortController()
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (event.type === "session.deleted") {
          const id = event.data?.sessionID
          if (id && loadStore().sessions[id]) updateStore((store) => delete store.sessions[id])
          costs.delete(id)
          if (id && loadSpend().sessions[id]) updateSpend((spend) => delete spend.sessions[id])
          rootCache.delete(id)
          backfills.delete(id)
          notified.delete(id)
          warned.delete(id)
          interrupted.delete(id)
          subagents.delete(id)
          branch.delete(id)
          continue
        }

        if (event.type === "session.forked") {
          // Pins the parent link before any cost event arrives, so a
          // sub-agent's very first `session.usage.updated` already resolves
          // to the right root instead of racing `ctx.session.get`.
          rootCache.set(event.data.sessionID, rootOf(event.data.parentID))
          continue
        }

        if (event.type !== "session.usage.updated") continue
        // Only a signal that this session's cost moved; the amount is re-read
        // from the session so repeated events cannot be counted twice.
        const { sessionID, cost } = event.data
        if (!(cost > 0)) continue

        const rootID = await rootOf(sessionID)
        await backfill(rootID)
        await refreshCost(rootID, sessionID)
        if (sessionID !== rootID) subagents.add(rootID)
        let ids = branch.get(rootID)
        if (!ids) branch.set(rootID, (ids = new Set([rootID])))
        ids.add(sessionID)
        publishSpent(rootID)
        await enforceRunning(rootID, sessionID)
      }
    })()

    return () => controller.abort()
  },
})
