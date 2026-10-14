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

const plugin = (await import("../src/index.js")).default

const ROOT_COST = 0.3886
const KID_COST = 0.427

/**
 * A fake plugin context shaped like the real one for the branch this plugin
 * cares about: a root session with one sub-agent child. `session.forked` pins
 * the parent link the way opencode emits it when the child session is
 * created, and `session.usage.updated` carries each message's cost the way
 * the real event stream does.
 */
function fakeContext() {
  const sessions = { root: { cost: 0 }, kid: { parentID: "root", cost: 0 } }
  const notifications = []
  const queue = []
  let waiting = null

  const ctx = {
    session: {
      get: async ({ sessionID }) => sessions[sessionID],
      interrupt: async () => {},
      prompt: async () => ({}),
      synthetic: async ({ sessionID, text }) => {
        notifications.push({ sessionID, text })
      },
      hook: async () => {},
    },
    command: {
      transform: async () => {},
    },
    event: {
      subscribe: async function* ({ signal }) {
        while (!signal.aborted) {
          if (queue.length) {
            yield queue.shift()
            continue
          }
          const next = await new Promise((resolve) => {
            waiting = resolve
          })
          if (next) yield next
        }
      },
    },
  }

  let eventID = 0
  return {
    ctx,
    sessions,
    notifications,
    emit: (event) => {
      const full = { id: `evt_${eventID++}`, ...event }
      if (waiting) {
        const resolve = waiting
        waiting = null
        resolve(full)
      } else {
        queue.push(full)
      }
    },
  }
}

/** Publishing is coalesced, so every assertion has to wait it out. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 400))

const readSpend = () => JSON.parse(readFileSync(spendFile, "utf8"))

async function runTurnWithSubagent() {
  const host = fakeContext()
  await plugin.setup(host.ctx)
  host.emit({ type: "session.forked", data: { sessionID: "kid", parentID: "root" } })
  host.sessions.root.cost = ROOT_COST
  host.emit({ type: "session.usage.updated", data: { sessionID: "root", cost: ROOT_COST } })
  host.sessions.kid.cost = KID_COST
  host.emit({ type: "session.usage.updated", data: { sessionID: "kid", cost: KID_COST } })
  await settle()
  return host
}

test("repeated usage events for one message count its cost once", async () => {
  const host = fakeContext()
  await plugin.setup(host.ctx)
  host.sessions.root.cost = ROOT_COST
  for (let i = 0; i < 4; i++) {
    host.emit({ type: "session.usage.updated", data: { sessionID: "root", cost: ROOT_COST } })
  }
  await settle()
  assert.equal(readSpend().sessions.root.spent, ROOT_COST, "the session's own total is the spend, however many events reported it")
})

test("the published total spans the whole branch, not just the visible session", async () => {
  await runTurnWithSubagent()

  const entry = readSpend().sessions.root
  assert.equal(
    Number(entry.spent.toFixed(4)),
    Number((ROOT_COST + KID_COST).toFixed(4)),
    "sub-agent spend is billed to the root and must be included",
  )
  assert.notEqual(entry.spent, ROOT_COST, "publishing the root's own cost would just reproduce the Context block")
})

test("the total is published under every session in the branch", async () => {
  await runTurnWithSubagent()

  const sessions = readSpend().sessions
  assert.ok(sessions.kid, "a sidebar opened on a sub-agent session needs an entry to read")
  assert.equal(sessions.kid.spent, sessions.root.spent, "one branch, one budget, one number")
})

test("the sub-agent flag is only set when a sub-agent actually spent", async () => {
  await runTurnWithSubagent()
  assert.equal(readSpend().sessions.root.subagents, true)

  // A fresh plugin instance, this time with no fork at all.
  const host = fakeContext()
  await plugin.setup(host.ctx)
  host.sessions.root.cost = ROOT_COST
  host.emit({ type: "session.usage.updated", data: { sessionID: "root", cost: ROOT_COST } })
  await settle()

  const entry = readSpend().sessions.root
  assert.equal(entry.spent, ROOT_COST)
  assert.equal(entry.subagents, false, "the title must not claim sub-agents on a session that had none")
})

test("a corrupt spend file is replaced rather than breaking the turn", async () => {
  const { writeFileSync, mkdirSync } = await import("fs")
  mkdirSync(join(home, ".local/share/opencode"), { recursive: true })
  writeFileSync(spendFile, "{ not json")

  await runTurnWithSubagent()
  assert.equal(Number(readSpend().sessions.root.spent.toFixed(4)), Number((ROOT_COST + KID_COST).toFixed(4)))
})

test("entries untouched for 30 days are pruned, as limits are", async () => {
  const { writeFileSync } = await import("fs")
  const stale = Date.now() - 31 * 24 * 60 * 60 * 1000
  writeFileSync(spendFile, JSON.stringify({ version: 1, sessions: { ses_old: { spent: 9, updatedAt: stale } } }))

  await runTurnWithSubagent()
  assert.equal(readSpend().sessions.ses_old, undefined)
})

test("the spend file is a sibling of the limits file, not a second source of truth for limits", async () => {
  const mod = await import("../src/budget-file.js")
  assert.equal(mod.resolveSpendFile(), join(mod.resolveBudgetDir(), "budget-spend.json"))
  assert.notEqual(mod.resolveSpendFile(), mod.resolveBudgetFile())
  assert.ok(existsSync(spendFile))
})
