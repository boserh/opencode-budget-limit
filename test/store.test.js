/**
 * The limits file is the plugin's only persistent state, and users upgrading
 * from a pre-1.0 install carry both an older path and an older schema. Losing
 * either silently resets everyone's limits, so both migrations are pinned here.
 *
 * HOME is redirected before importing anything: budget-file.js derives
 * LEGACY_BUDGET_FILE from homedir() at import time, and the ESM cache means
 * that only happens once per process.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

const home = mkdtempSync(join(tmpdir(), "budget-store-"))
process.env.HOME = home
delete process.env.XDG_DATA_HOME
delete process.env.OPENCODE_BUDGET_FILE

const legacyDir = join(home, ".config/opencode/plugins")
const legacyFile = join(legacyDir, "budget-limit.json")
const currentFile = join(home, ".local/share/opencode/budget-limit.json")

const { loadStore, saveStore } = await import("../src/server.js")

const readCurrent = () => JSON.parse(readFileSync(currentFile, "utf8"))
const DAY = 24 * 60 * 60 * 1000

test("a missing file yields an empty v2 store rather than throwing", () => {
  const store = loadStore()
  assert.equal(store.version, 2)
  assert.deepEqual(store.sessions, {})
})

test("a v1 flat file at the legacy path migrates to v2 at the new path", () => {
  mkdirSync(legacyDir, { recursive: true })
  writeFileSync(legacyFile, JSON.stringify({ ses_abc: 5, ses_def: 12.5 }))

  const store = loadStore()
  assert.equal(store.version, 2)
  assert.equal(store.sessions.ses_abc.limit, 5)
  assert.equal(store.sessions.ses_def.limit, 12.5)
  assert.ok(store.sessions.ses_abc.updatedAt > 0, "migrated entries need a timestamp or they prune immediately")

  saveStore(store)
  assert.ok(existsSync(currentFile), "the first write must land at the new path")
  assert.equal(readCurrent().sessions.ses_abc.limit, 5)
  assert.ok(existsSync(legacyFile), "the legacy file is left in place, not deleted")
})

test("a v2 file is read back unchanged, including unlimited sessions", () => {
  saveStore({
    version: 2,
    default: 3,
    sessions: {
      ses_capped: { limit: 5, updatedAt: Date.now() },
      ses_free: { limit: "unlimited", updatedAt: Date.now() },
    },
  })

  const store = loadStore()
  assert.equal(store.default, 3)
  assert.equal(store.sessions.ses_capped.limit, 5)
  assert.equal(store.sessions.ses_free.limit, "unlimited")
})

test("entries untouched for 30 days are pruned on write", () => {
  const now = Date.now()
  saveStore({
    version: 2,
    default: 1,
    sessions: {
      ses_stale: { limit: 5, updatedAt: now - 31 * DAY },
      ses_recent: { limit: 5, updatedAt: now - 29 * DAY },
    },
  })

  const sessions = readCurrent().sessions
  assert.equal(sessions.ses_stale, undefined)
  assert.ok(sessions.ses_recent, "entries inside the window must survive")
})

test("a corrupt file degrades to an empty store instead of breaking startup", () => {
  writeFileSync(currentFile, "{ not json")
  const store = loadStore()
  assert.equal(store.version, 2)
  assert.deepEqual(store.sessions, {})
})
