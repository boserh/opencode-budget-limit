/**
 * The sidebar shows whatever the server publishes here, so a regression in this
 * file does not throw — it quietly puts a wrong number under a user's limit.
 * The specific failure being guarded against is the one this file was written
 * to fix: a total that counts only the visible session, matching the host's
 * Context block while the run is stopped at a figure twice as high.
 *
 * HOME is redirected before importing anything, because budget-file.js derives
 * the legacy path from homedir() at import time.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, existsSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

const home = mkdtempSync(join(tmpdir(), "budget-spend-"))
process.env.HOME = home
delete process.env.XDG_DATA_HOME
delete process.env.OPENCODE_BUDGET_FILE

const spendFile = join(home, ".local/share/opencode/budget-spend.json")

const { BudgetPlugin } = await import("../src/server.js")

const ROOT_COST = 0.3886
const KID_COST = 0.427

/**
 * A host stub shaped like the real one for the branch this plugin cares about:
 * a root session with one sub-agent child, each holding its own messages.
 * Costs are the ones observed in a real session, so the expected total is a
 * figure that actually occurred rather than an invented round number.
 */
function fakeClient({ children = ["kid"] } = {}) {
  const sessions = { root: {}, kid: { parentID: "root" }, grandkid: { parentID: "kid" } }
  const messages = {
    root: [{ info: { id: "m_root", role: "assistant", cost: ROOT_COST, sessionID: "root" } }],
    kid: [{ info: { id: "m_kid", role: "assistant", cost: KID_COST, sessionID: "kid" } }],
  }
  const toasts = []
  return {
    toasts,
    messages,
    client: {
      session: {
        get: async ({ path }) => ({ data: sessions[path.id] }),
        children: async () => ({ data: children.map((id) => ({ id })) }),
        messages: async ({ path }) => ({ data: messages[path.id] ?? [] }),
        abort: async () => ({}),
      },
      tui: {
        showToast: async ({ body }) => toasts.push(body.message),
        appendPrompt: async () => ({}),
      },
    },
  }
}

/** Publishing is coalesced, so every assertion has to wait it out. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 400))

const readSpend = () => JSON.parse(readFileSync(spendFile, "utf8"))

async function runTurn(options) {
  const host = fakeClient(options)
  const hooks = await BudgetPlugin({ client: host.client, directory: home })
  await hooks.event({ event: { type: "message.updated", properties: { info: host.messages.kid[0].info } } })
  await settle()
  return host
}

test("the published total spans the whole branch, not just the visible session", async () => {
  await runTurn()

  const entry = readSpend().sessions.root
  assert.equal(
    Number(entry.spent.toFixed(4)),
    Number((ROOT_COST + KID_COST).toFixed(4)),
    "sub-agent spend is billed to the root and must be included",
  )
  assert.notEqual(entry.spent, ROOT_COST, "publishing the root's own cost would just reproduce the Context block")
})

test("the total is published under every session in the branch", async () => {
  await runTurn()

  const sessions = readSpend().sessions
  assert.ok(sessions.kid, "a sidebar opened on a sub-agent session needs an entry to read")
  assert.equal(sessions.kid.spent, sessions.root.spent, "one branch, one budget, one number")
})

test("the sub-agent flag is only set when a sub-agent actually spent", async () => {
  await runTurn()
  assert.equal(readSpend().sessions.root.subagents, true)

  // A fresh plugin instance, this time with a childless root.
  const host = fakeClient({ children: [] })
  const hooks = await BudgetPlugin({ client: host.client, directory: home })
  await hooks.event({ event: { type: "message.updated", properties: { info: host.messages.root[0].info } } })
  await settle()

  const entry = readSpend().sessions.root
  assert.equal(entry.spent, ROOT_COST)
  assert.equal(entry.subagents, false, "the title must not claim sub-agents on a session that had none")
})

test("sub-agent cost is picked up from the session store, not only from live events", async () => {
  // Only the root's own message is announced. The child's spend therefore has
  // to come from the backfill walk over session.children() — which is the code
  // path that separates this plugin's total from the Context block's, and the
  // one a live-event test silently leaves uncovered.
  const host = fakeClient()
  const hooks = await BudgetPlugin({ client: host.client, directory: home })
  await hooks.event({ event: { type: "message.updated", properties: { info: host.messages.root[0].info } } })
  await settle()

  const entry = readSpend().sessions.root
  assert.equal(Number(entry.spent.toFixed(4)), Number((ROOT_COST + KID_COST).toFixed(4)))
  assert.equal(entry.subagents, true)
})

test("a corrupt spend file is replaced rather than breaking the turn", async () => {
  const { writeFileSync, mkdirSync } = await import("fs")
  mkdirSync(join(home, ".local/share/opencode"), { recursive: true })
  writeFileSync(spendFile, "{ not json")

  await runTurn()
  assert.equal(Number(readSpend().sessions.root.spent.toFixed(4)), Number((ROOT_COST + KID_COST).toFixed(4)))
})

test("entries untouched for 30 days are pruned, as limits are", async () => {
  const { writeFileSync } = await import("fs")
  const stale = Date.now() - 31 * 24 * 60 * 60 * 1000
  writeFileSync(spendFile, JSON.stringify({ version: 1, sessions: { ses_old: { spent: 9, updatedAt: stale } } }))

  await runTurn()
  assert.equal(readSpend().sessions.ses_old, undefined)
})

test("the spend file is a sibling of the limits file, not a second source of truth for limits", async () => {
  const mod = await import("../src/budget-file.js")
  assert.equal(mod.resolveSpendFile(), join(mod.resolveBudgetDir(), "budget-spend.json"))
  assert.notEqual(mod.resolveSpendFile(), mod.resolveBudgetFile())
  assert.ok(existsSync(spendFile))
})
