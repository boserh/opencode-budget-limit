/**
 * Popups are the only place limit warnings surface since the server stopped
 * posting them into the transcript, so a regression here is silent: the run
 * just stops with nothing on screen to say why.
 */
import { test } from "node:test"
import assert from "node:assert/strict"

delete process.env.OPENCODE_BUDGET_WARN

const { budgetToasts } = await import("../src/toasts.js")

function setup() {
  const shown = []
  const toast = budgetToasts({ ui: { toast: { show: (options) => shown.push(options) } } })
  return { shown, toast }
}

test("the first reading of a session stays quiet, even over budget", () => {
  const { shown, toast } = setup()
  toast("ses_a", 5, 1)
  assert.deepEqual(shown, [])
})

test("each warning threshold toasts once, on the way up", () => {
  const { shown, toast } = setup()
  toast("ses_a", 0.1, 1)
  toast("ses_a", 0.55, 1)
  toast("ses_a", 0.6, 1)
  toast("ses_a", 0.85, 1)
  assert.deepEqual(
    shown.map((t) => t.variant),
    ["warning", "warning"],
  )
  assert.match(shown[1].message, /85% used/)
})

test("jumping past several thresholds at once toasts only the highest", () => {
  const { shown, toast } = setup()
  toast("ses_a", 0.1, 1)
  toast("ses_a", 0.97, 1)
  assert.equal(shown.length, 1)
  assert.match(shown[0].message, /97% used/)
})

test("reaching the limit is an error toast, shown once", () => {
  const { shown, toast } = setup()
  toast("ses_a", 0.9, 1)
  toast("ses_a", 1.02, 1)
  toast("ses_a", 1.05, 1)
  assert.deepEqual(
    shown.map((t) => t.variant),
    ["error"],
  )
  assert.equal(shown[0].sessionID, "ses_a")
})

test("a changed limit toasts success and re-arms the warnings", () => {
  const { shown, toast } = setup()
  toast("ses_a", 1.02, 1)
  toast("ses_a", 1.02, 10)
  toast("ses_a", 5.5, 10)
  assert.deepEqual(
    shown.map((t) => t.variant),
    ["success", "warning"],
  )
  assert.match(shown[0].message, /\$10\.00/)
})

test("switching sessions re-baselines instead of toasting", () => {
  const { shown, toast } = setup()
  toast("ses_a", 0.1, 1)
  toast("ses_b", 0.9, 3)
  assert.deepEqual(shown, [])
})

test("an unlimited session never warns", () => {
  const { shown, toast } = setup()
  toast("ses_a", 1, Infinity)
  toast("ses_a", 50, Infinity)
  assert.deepEqual(shown, [])
})
