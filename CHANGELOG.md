# Changelog

## 2.0.6

- Toasts are back: threshold warnings, "limit reached" and limit changes are
  shown as TUI popups again, raised by the sidebar entry. The server now posts
  into the transcript only to answer `/budget`.
- Fix tracked spend running 3-9x high: costs are read from each session's own
  total instead of being summed per `session.usage.updated` event (2.0.5).
- Fix `/budget` changes reverting after the next turn when opencode runs
  several plugin instances (2.0.4).
- Fix `/budget` replies starting a new agent turn (2.0.3).
- Port the sidebar to the V2 TUI plugin API (2.0.2).

## 2.0.0

Ports the plugin to the OpenCode V2 plugin API (`@opencode/plugin`,
`Plugin.define`, `setup(ctx)`). V1's plugin runtime does not load under
OpenCode 2.x, so this is a breaking change for anyone still on OpenCode 1.x —
stay on `1.0.2` there.

- The server entry (`src/index.ts`, replacing `src/server.js`) now registers
  hooks and transforms on `ctx` instead of returning a hooks object. The
  `/budget` command is now registered directly via `ctx.command.transform`,
  so the separate `~/.config/opencode/commands/budget.md` file is no longer
  needed — delete it after upgrading.
- Toasts have no server-side equivalent in V2 (toasts are a CLI-only concept),
  so budget notices are now delivered as synthetic session messages instead.
- Turn gating moved from the removed `chat.message` hook to the `context`
  session hook, which also now catches tool-driven continuations mid-turn.
- `engines.opencode` raised to `>=2.0.0`.

## 1.0.0

First stable release. The plugin API and the on-disk format are settled: the
limits file is at `version: 2`, and older files are migrated on read rather than
discarded.

- Tests for limits-file path resolution and for migration from the pre-1.0
  location and schema, run on Node 20 and 22 across Linux and macOS in CI.
- No functional changes from 0.1.0.

## 0.1.0

Initial release: per-session spend limits, warning toasts, sidebar readout,
`/budget` slash command, and resume-after-limit via the prompt box.
