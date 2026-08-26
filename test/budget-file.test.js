/**
 * The two entries only agree on one limits file because they both call these
 * helpers. Anything that changes path resolution changes where every existing
 * user's limits live, so the precedence order is pinned here.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

/**
 * budget-file.js reads process.env at call time, but LEGACY_BUDGET_FILE is
 * derived from homedir() at import time. Each case therefore gets a fresh
 * module instance, keyed by a unique query string to defeat the ESM cache.
 *
 * The environment stays patched for the duration of `body`, because the
 * resolvers read it lazily — restoring it before the assertions would make
 * every case read the developer's real home directory.
 */
let instance = 0
async function withEnv(env, body) {
  const saved = {}
  for (const key of ["OPENCODE_BUDGET_FILE", "XDG_DATA_HOME", "HOME"]) {
    saved[key] = process.env[key]
    if (env[key] === undefined) delete process.env[key]
    else process.env[key] = env[key]
  }
  try {
    return await body(await import(`../src/budget-file.js?case=${instance++}`))
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

const scratch = () => mkdtempSync(join(tmpdir(), "budget-test-"))

test("OPENCODE_BUDGET_FILE wins over everything else", async () => {
  await withEnv(
    { OPENCODE_BUDGET_FILE: "/tmp/explicit/limits.json", XDG_DATA_HOME: "/tmp/ignored", HOME: "/tmp/ignored-home" },
    (mod) => {
      assert.equal(mod.resolveBudgetFile(), "/tmp/explicit/limits.json")
      assert.equal(mod.resolveBudgetDir(), "/tmp/explicit")
    },
  )
})

test("XDG_DATA_HOME is honoured, matching opencode's own Global.data", async () => {
  await withEnv({ XDG_DATA_HOME: "/tmp/xdg", HOME: "/tmp/home" }, (mod) => {
    assert.equal(mod.resolveBudgetFile(), "/tmp/xdg/opencode/budget-limit.json")
  })
})

test("falls back to ~/.local/share when XDG_DATA_HOME is unset", async () => {
  const home = scratch()
  await withEnv({ HOME: home }, (mod) => {
    assert.equal(mod.resolveBudgetFile(), join(home, ".local/share/opencode/budget-limit.json"))
  })
})

test("the state dir is never used: the path sits under share, not state", async () => {
  await withEnv({ HOME: "/tmp/home" }, (mod) => {
    assert.ok(!mod.resolveBudgetFile().includes("/.local/state/"))
  })
})

test("reads the legacy config-dir file while the new one is missing", async () => {
  const home = scratch()
  const legacy = join(home, ".config/opencode/plugins")
  mkdirSync(legacy, { recursive: true })
  writeFileSync(join(legacy, "budget-limit.json"), "{}")

  await withEnv({ HOME: home }, (mod) => {
    assert.equal(mod.resolveReadFile(), join(legacy, "budget-limit.json"))
  })
})

test("prefers the new file once it exists, leaving the legacy one behind", async () => {
  const home = scratch()
  const legacy = join(home, ".config/opencode/plugins")
  const current = join(home, ".local/share/opencode")
  mkdirSync(legacy, { recursive: true })
  mkdirSync(current, { recursive: true })
  writeFileSync(join(legacy, "budget-limit.json"), "{}")
  writeFileSync(join(current, "budget-limit.json"), "{}")

  await withEnv({ HOME: home }, (mod) => {
    assert.equal(mod.resolveReadFile(), join(current, "budget-limit.json"))
  })
})

test("with neither file present, reads point at the new location", async () => {
  const home = scratch()
  await withEnv({ HOME: home }, (mod) => {
    assert.equal(mod.resolveReadFile(), mod.resolveBudgetFile())
  })
})

test("writes always target the new location and create its directory", async () => {
  const home = scratch()
  const legacy = join(home, ".config/opencode/plugins")
  mkdirSync(legacy, { recursive: true })
  writeFileSync(join(legacy, "budget-limit.json"), "{}")

  await withEnv({ HOME: home }, (mod) => {
    assert.equal(mod.resolveWriteFile(), join(home, ".local/share/opencode/budget-limit.json"))
    assert.ok(existsSync(join(home, ".local/share/opencode")), "write target directory should be created")
  })
})
