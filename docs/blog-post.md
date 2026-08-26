# Writing an opencode TUI plugin: what the docs don't tell you

*Draft. Target: the project's GitHub Discussions / Discord first, then Show HN.*

---

opencode plugins are documented as a single idea: a module that exports some
hooks, listed in your config. That description is accurate for a plugin that
only touches the server. The moment you want to draw something in the sidebar,
you walk into four undocumented constraints, in roughly this order, each of
which fails in a way that does not point at its own cause.

I hit all four building [opencode-budget-limit][plugin], a plugin that puts a
spend ceiling on a session and shows the remaining budget in the sidebar. None
of what follows is specific to that plugin. Anything with a TUI half meets the
same walls.

[plugin]: https://github.com/boserh/opencode-budget-limit

## 1. There are two plugin configs, and neither falls back to the other

Server plugins are listed in `opencode.json`. TUI plugins are listed in
`tui.json`. These are separate files with separate loaders, and a package listed
in one is invisible to the other.

```json
// ~/.config/opencode/opencode.json
{ "plugin": ["opencode-budget-limit"] }
```

```json
// ~/.config/opencode/tui.json
{ "plugin": ["opencode-budget-limit"] }
```

The failure mode is what makes this expensive: listing the package in only
`opencode.json` gives you a plugin that works perfectly and draws nothing. There
is no warning, because from the server's point of view nothing is wrong. You go
looking for a bug in your render code that does not exist.

Note that relative paths in either file resolve against *that file's*
directory — useful while developing from a checkout.

## 2. A module cannot export both halves

The natural shape for a two-part plugin is one entry point:

```js
export default { id: "my-plugin", server: MyServer, tui: MyTui } // rejected
```

opencode refuses this outright. A module default-exports `{ id, server }` **or**
`{ id, tui }`, never both. So a package that does both needs two modules and two
`exports` keys:

```json
"exports": {
  "./server": "./src/server.js",
  "./tui": "./dist/tui.js"
}
```

Which, combined with the previous point, is why installation touches two files
and two subpaths. Shared state between the halves has to live in a third module
that both import — for me, path resolution for the limits file, which the two
halves must agree on or the sidebar reports a different number than the one
being enforced.

## 3. The JSX transform deliberately skips `node_modules`

This is the one that cost me the most time, because it works right up until you
publish.

opencode compiles Solid JSX on the fly with a Bun plugin. Its filter:

```
/^(?!.*[/\\]node_modules[/\\]).*\.[cm]?[jt]sx?(?:[?#].*)?$/
```

The leading negative lookahead excludes anything under `node_modules`. While you
develop from a checkout outside `node_modules`, raw `.tsx` is transformed and
everything works. Install the same package from npm and the file is skipped, so
the host tries to run raw JSX and your plugin dies on import.

A published package must therefore ship precompiled JS. The compile has to
mirror the host's own options, or the output targets the wrong runtime:

```js
transformAsync(code, {
  presets: [
    [solid, { moduleName: "@opentui/solid", generate: "universal" }],
    [typescript, { isTSX: true, allExtensions: true }],
  ],
})
```

There is a wrinkle worth knowing: leave imports of `solid-js` and
`@opentui/solid` as **bare specifiers** in the compiled output. opencode rewrites
them to its own runtime, and unlike the JSX transform, that rewriting *does*
apply inside `node_modules`. Bundling them instead gives you a second copy of
Solid and a reactive graph that silently does not update. They stay
devDependencies; the published package can have no runtime dependencies at all.

## 4. `path.state` is not the data directory

`TuiState` exposes `path.state`, which reads like the obvious place to put
persistent plugin state. It resolves from `XDG_STATE_HOME`
(`~/.local/state/opencode`) — a different base from the data directory that
`Global.data`, and opencode's own storage, derive from `XDG_DATA_HOME`
(`~/.local/share/opencode`).

That alone is survivable. What is not: the *server* half has no equivalent. The
`PluginInput` a server plugin receives is only

```
{ client, project, directory, worktree, serverUrl, $ }
```

No paths at all. So if the TUI half writes to `path.state` and the server half
computes a path itself, the two halves read different files and disagree
forever. The fix is to derive the path from `XDG_DATA_HOME` in a shared module
that both import, and never touch `path.state`.

## Two smaller ones, while I'm here

**You cannot reject a turn from a hook.** Throwing inside `chat.message`
surfaces to the user as `Unexpected server error`, which is not a message you
want to ship. Rewriting the payload to something harmless produces malformed
conversations later. What works is letting the turn start and immediately
calling `session.abort()` — the request dies before tokens are spent and the
TUI renders a normal cancellation. Fire the abort a few times over the first
half-second, because the run may not be registered yet when your hook returns.

**An aborted run cannot be restarted through the API.** Only a fresh prompt
continues it. Rather than synthesising a turn on the user's behalf, I use
`tui.appendPrompt()` to drop the word `continue` into the prompt box — one
keypress to resume, and the wording stays theirs. Defer it by a few hundred
milliseconds if it follows a slash command, because the TUI clears the prompt
after a command runs and will wipe text appended synchronously.

## Why write this down

Every one of these is discoverable in the source, and none of them is
discoverable from the failure. The gap between "my plugin renders nothing" and
"there is a second config file" is a couple of hours with a debugger — and it is
the same couple of hours for everyone who tries.

The plugin these came out of is [opencode-budget-limit][plugin]: per-session
spend limits, a sidebar readout, and a hard stop when a session hits the
ceiling. MIT, and the two-entry layout above is exactly how it is put together
if you want a working reference rather than a list of warnings.
