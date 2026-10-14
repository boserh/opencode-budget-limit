/**
 * OpenCode loads one plugin instance per project location, and every instance
 * shares the same limits file. A limit raised through one instance must hold
 * in all of them: the regression this guards against is a /budget change that
 * reverted on the next turn because another instance enforced, then saved,
 * its own stale copy of the store.
 *
 * HOME is redirected before importing anything, because budget-file.js derives
 * the legacy path from homedir() at import time.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

const home = mkdtempSync(join(tmpdir(), "budget-instances-"))
process.env.HOME = home
delete process.env.XDG_DATA_HOME
delete process.env.OPENCODE_BUDGET_FILE
delete process.env.OPENCODE_BUDGET_DEFAULT

const limitsFile = join(home, ".local/share/opencode/budget-limit.json")

const plugin = (await import("../src/index.js")).default

/** One instance: captures the /budget command and the turn gate it registers. */
async function instance() {
  const interrupts = []
  let command
  let gate
  const ctx = {
    session: {
      get: async () => ({}),
      context: async () => [{ id: "msg_1", type: "assistant", cost: 2 }],
      interrupt: async ({ sessionID }) => interrupts.push(sessionID),
      prompt: async () => ({}),
      synthetic: async () => {},
      hook: async (name, callback) => {
        if (name === "context") gate = callback
      },
    },
    command: {
      transform: async (callback) => callback({ add: (definition) => (command = definition) }),
    },
    event: {
      subscribe: async function* ({ signal }) {
        await new Promise((resolve) => signal.addEventListener("abort", resolve))
      },
    },
  }
  const cleanup = await plugin.setup(ctx)
  return {
    interrupts,
    budget: (text) => command.execute({ sessionID: "root", prompt: { text } }),
    turn: () => gate({ sessionID: "root" }),
    cleanup,
  }
}

const storedLimit = () => JSON.parse(readFileSync(limitsFile, "utf8")).sessions.root?.limit

test("a limit raised in one instance holds in the others", async () => {
  // Both start with the default $1 limit while $2 is already spent.
  const a = await instance()
  const b = await instance()

  await a.budget("10")
  assert.equal(storedLimit(), 10)

  await b.turn()
  assert.deepEqual(b.interrupts, [], "the other instance must enforce the new limit, not its startup copy")
  assert.equal(storedLimit(), 10, "the other instance must not write its stale limit back")

  await a.cleanup?.()
  await b.cleanup?.()
})
