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
import { resolveReadFile } from "./budget-file.js"

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

function BudgetPanel(props) {
  const theme = () => props.api.theme.current

  const [limit, setLimit] = createSignal(readLimit(props.session_id))
  const timer = setInterval(() => setLimit(readLimit(props.session_id)), POLL_MS)
  onCleanup(() => clearInterval(timer))

  /**
   * Prefer the session rollup the built-in Context block uses; fall back to
   * summing assistant messages if the running host does not expose it.
   */
  const spent = createMemo(() => {
    const session = props.api.state.session.get?.(props.session_id)
    if (typeof session?.cost === "number") return session.cost
    let total = 0
    for (const message of props.api.state.session.messages(props.session_id)) {
      if (message.role === "assistant" && message.cost > 0) total += message.cost
    }
    return total
  })

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
