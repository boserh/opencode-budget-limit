/**
 * Sidebar readout for the spend limit enforced by the server entry.
 *
 * This is a different surface from the server plugin: the module default-exports
 * a V2 TUI definition (`Plugin.define({ id, setup })` from
 * `@opencode/plugin/tui`) and claims a place in the host slot tree instead of
 * subscribing to events. The host resolves it through `exports["./tui"]` in
 * package.json, and that entry must stay inside the package directory.
 *
 * The host's Solid JSX transform deliberately skips node_modules, so this file
 * is compiled ahead of time by build.mjs and shipped as dist/tui.js.
 *
 * `sidebar.content` is the same slot the built-in Context block renders into.
 */
import { readFileSync } from "fs"
import { Plugin } from "@opencode/plugin/tui"
import { createMemo, createSignal, onCleanup } from "solid-js"
import { resolveReadFile, resolveSpendFile } from "./budget-file.js"
import { budgetToasts } from "./toasts.js"

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
  const theme = () => props.ctx.theme

  const initial = readSpend(props.sessionID)
  const [limit, setLimit] = createSignal(readLimit(props.sessionID))
  const [spent, setSpent] = createSignal(initial?.spent ?? 0)
  const [subagents, setSubagents] = createSignal(initial?.subagents ?? false)

  const toast = budgetToasts(props.ctx)
  const poll = () => {
    setLimit(readLimit(props.sessionID))
    const next = readSpend(props.sessionID)
    if (next) {
      setSpent(next.spent)
      setSubagents(next.subagents)
    }
    toast(props.sessionID, spent(), limit())
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
    if (value === null) return theme().text.muted
    if (value >= 0.95) return theme().text.feedback.error.base
    if (value >= 0.8) return theme().text.feedback.warning.base
    return theme().text.feedback.success.base
  })

  return (
    <box>
      <text fg={theme().text.base}>
        <b>Budget</b>
        {subagents() ? " (with sub-agents)" : ""}
      </text>
      {ratio() === null ? (
        <text fg={theme().text.muted}>{currency.format(spent())} spent, no limit</text>
      ) : (
        <>
          <text fg={colour()}>{bar()}</text>
          <text fg={theme().text.muted}>
            {currency.format(spent())} of {currency.format(limit())}
          </text>
          <text fg={theme().text.muted}>{Math.round(ratio() * 100)}% used</text>
        </>
      )}
    </box>
  )
}

export default Plugin.define({
  id: "budget-limit-sidebar",
  setup(ctx) {
    // Appended inside the sidebar boundary, so it lands after the built-in
    // Context block. The returned release function is the plugin's cleanup.
    return ctx.ui.slot({
      append: "sidebar.content",
      render: (input) => <BudgetPanel ctx={ctx} sessionID={input.sessionID} />,
    })
  },
})
