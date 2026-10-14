/**
 * Compiles src/tui.tsx to dist/tui.js.
 *
 * The host installs a Bun plugin that applies babel-preset-solid on the fly,
 * but its filter excludes node_modules:
 *   /^(?!.*[/\\]node_modules[/\\]).*\.[cm]?[jt]sx?(?:[?#].*)?$/
 * An installed package therefore never gets transformed and must ship compiled
 * JS. The preset options below mirror the host's so the output targets the same
 * universal runtime.
 *
 * Imports of solid-js and @opentui/solid are left as bare specifiers on purpose:
 * the host rewrites them to its own runtime, and that rewriting does apply
 * inside node_modules. They must stay devDependencies.
 */
import { transformAsync } from "@babel/core"
import solid from "babel-preset-solid"
import typescript from "@babel/preset-typescript"
import { mkdir, readFile, writeFile, copyFile } from "fs/promises"
import { dirname, join } from "path"
import { fileURLToPath } from "url"

const root = dirname(fileURLToPath(import.meta.url))
const src = join(root, "src", "tui.tsx")
const outDir = join(root, "dist")
const out = join(outDir, "tui.js")

const code = await readFile(src, "utf8")
const result = await transformAsync(code, {
  filename: src,
  configFile: false,
  babelrc: false,
  presets: [
    [solid, { moduleName: "@opentui/solid", generate: "universal" }],
    [typescript, { isTSX: true, allExtensions: true }],
  ],
})

if (!result?.code) throw new Error("babel produced no output")

await mkdir(outDir, { recursive: true })
await writeFile(out, result.code)
// dist/tui.js imports these helpers, so they ship next to it.
await copyFile(join(root, "src", "budget-file.js"), join(outDir, "budget-file.js"))
await copyFile(join(root, "src", "toasts.js"), join(outDir, "toasts.js"))

console.log(`built ${out} (${result.code.length} bytes)`)
