/**
 * Single source of truth for where the limits file lives.
 *
 * Both entries (server and tui) import this module, which is the only way to
 * guarantee they agree on one file. Do not inline this logic anywhere.
 *
 * Precedence:
 *   1. OPENCODE_BUDGET_FILE — explicit override, used verbatim
 *   2. XDG_DATA_HOME        — commonly overridden on Linux, and opencode itself
 *                             honours it (Global.data is derived from it)
 *   3. ~/.local/share       — the XDG default
 * then `opencode/budget-limit.json` is appended.
 *
 * `TuiState.path.state` is deliberately NOT used. It resolves from
 * XDG_STATE_HOME (~/.local/state/opencode), a different base from the data dir,
 * and the server entry has no path available to match it — PluginInput is only
 * { client, project, directory, worktree, serverUrl, $ }. Using it would make
 * the two entries read different files.
 *
 * Supported platforms: macOS and Linux.
 */
import { homedir } from "os"
import { join, dirname } from "path"
import { existsSync, mkdirSync } from "fs"

/** Pre-1.0 location, back when the plugin was a loose file in the config dir. */
export const LEGACY_BUDGET_FILE = join(homedir(), ".config", "opencode", "plugins", "budget-limit.json")

/** Absolute path to the limits file. Identical in every entry. */
export function resolveBudgetFile() {
  const override = process.env.OPENCODE_BUDGET_FILE
  if (override) return override
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
  return join(dataHome, "opencode", "budget-limit.json")
}

/**
 * Absolute path to the spend cache.
 *
 * Kept apart from the limits file because the two have different natures: a
 * limit is user intent and must survive anything, whereas spend is derived
 * from the session store and can be recomputed at will. Splitting them also
 * keeps a per-turn write off the file that holds the intent.
 *
 * Written only by the server entry, read only by the tui entry. That direction
 * is what stops the sidebar and the enforcement from disagreeing: there is one
 * implementation of the sum, not two.
 */
export function resolveSpendFile() {
  return join(resolveBudgetDir(), "budget-spend.json")
}

/** Directory holding the limits file, for siblings such as the debug log. */
export function resolveBudgetDir() {
  return dirname(resolveBudgetFile())
}

/**
 * File to read from. Falls back to the legacy location, read-only, until the
 * next write migrates it.
 */
export function resolveReadFile() {
  const current = resolveBudgetFile()
  if (existsSync(current)) return current
  if (existsSync(LEGACY_BUDGET_FILE)) return LEGACY_BUDGET_FILE
  return current
}

/** File to write to. Always the current location; creates its directory. */
export function resolveWriteFile() {
  const current = resolveBudgetFile()
  try {
    mkdirSync(dirname(current), { recursive: true })
  } catch {}
  return current
}

/** Fractions of the limit that raise a one-off warning toast. */
export const WARN_AT = (process.env.OPENCODE_BUDGET_WARN ?? "0.5,0.8,0.95")
  .split(",")
  .map((v) => Number.parseFloat(v))
  .filter((v) => Number.isFinite(v) && v > 0 && v < 1)
  .sort((a, b) => a - b)
