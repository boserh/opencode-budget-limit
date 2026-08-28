/**
 * Sidebar readout for the spend limit enforced by the server entry.
 *
 * This is a different surface from a server plugin: the module default-exports
 * `{ id, tui }` and renders Solid JSX into a host slot instead of returning hook
 * factories. The host resolves it through `exports["./tui"]` in package.json,
 * and that entry must stay inside the package directory.
 *
 * The host's Solid JSX transform deliberately skips node_modules, so this file
 * is compiled ahead of time by build.mjs and shipped as dist/tui.js.
 *
 * `sidebar_content` is the same slot the built-in Context block renders into.
 */
import { readFileSync } from "fs"
import { createMemo, createSignal, onCleanup } from "solid-js"
import { resolveReadFile, resolveSpendFile } from "./budget-file.js"

const FALLBACK_DEFAULT = Number(process.env.OPENCODE_BUDGET_DEFAULT) || 1
const POLL_MS = 2000
const BAR_WIDTH = 10

const currency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })

/**
 * Limits are owned by the server plugin and can change while the TUI is open,
 * so re-read the file on every poll instead of caching it.
 */
function readLimit(sessionID) {
  try {
    const raw = JSON.parse(readFileSync(resolveReadFile(), "utf8"))
    const fallback = typeof raw?.default === "number" ? raw.default : FALLBACK_DEFAULT
    const entry = raw?.sessions?.[sessionID]
    if (!entry) return fallback
    if (entry.limit === "unlimited" || entry.limit === null) return Infinity
    return typeof entry.limit === "number" ? entry.limit : fallback
  } catch {
    return FALLBACK_DEFAULT
  }
}

/**
 * Spend is read, never computed here.
 *
 * The TUI state API can only reach one session at a time, so a sum built in
 * this file would silently exclude the sub-agent sessions a run spawned — the
 * same blind spot the host's Context block has. The server entry already walks
 * root plus children to decide when to stop a run, and publishes that total;
 * reading it back is what keeps the bar and the enforcement on one number.
 */
function readSpend(sessionID) {
  try {
    const raw = JSON.parse(readFileSync(resolveSpendFile(), "utf8"))
    const entry = raw?.sessions?.[sessionID]
    if (typeof entry?.spent !== "number") return null
    return { spent: entry.spent, subagents: entry.subagents === true }
  } catch {
    return null
  }
}

function BudgetPanel(props) {
  const theme = () => props.api.theme.current

  const initial = readSpend(props.session_id)
  const [limit, setLimit] = createSignal(readLimit(props.session_id))
  const [spent, setSpent] = createSignal(initial?.spent ?? 0)
  const [subagents, setSubagents] = createSignal(initial?.subagents ?? false)

  const poll = () => {
    setLimit(readLimit(props.session_id))
    const next = readSpend(props.session_id)
    if (!next) return
    setSpent(next.spent)
    setSubagents(next.subagents)
  }
  const timer = setInterval(poll, POLL_MS)
  onCleanup(() => clearInterval(timer))

  /** null means "no finite limit", which renders as an unlimited session. */
  const ratio = createMemo(() => {
    const max = limit()
    if (!Number.isFinite(max) || max <= 0) return null
    return Math.min(1, spent() / max)
  })

  const bar = createMemo(() => {
    const value = ratio()
    if (value === null) return ""
    return "█".repeat(Math.round(value * BAR_WIDTH)).padEnd(BAR_WIDTH, "░")
  })

  const colour = createMemo(() => {
    const value = ratio()
    if (value === null) return theme().textMuted
    if (value >= 0.95) return theme().error
    if (value >= 0.8) return theme().warning
    return theme().success
  })

  return (
    <box>
      <text fg={theme().text}>
        <b>Budget</b>
        {subagents() ? " (with sub-agents)" : ""}
      </text>
      {ratio() === null ? (
        <text fg={theme().textMuted}>{currency.format(spent())} spent, no limit</text>
      ) : (
        <>
          <text fg={colour()}>{bar()}</text>
          <text fg={theme().textMuted}>
            {currency.format(spent())} of {currency.format(limit())}
          </text>
          <text fg={theme().textMuted}>{Math.round(ratio() * 100)}% used</text>
        </>
      )}
    </box>
  )
}

export const BudgetSidebar = {
  id: "budget-limit-sidebar",
  tui: async (api) => {
    api.slots.register({
      // Directly under the built-in Context block (100); files render at 500.
      order: 150,
      slots: {
        sidebar_content(_ctx, props) {
          return <BudgetPanel api={api} session_id={props.session_id} />
        },
      },
    })
  },
}

export default BudgetSidebar
