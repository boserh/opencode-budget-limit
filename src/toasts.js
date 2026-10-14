import { WARN_AT } from "./budget-file.js"

const currency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })

const formatLimit = (limit) => (Number.isFinite(limit) ? currency.format(limit) : "unlimited")

/**
 * Popups for the moments that need attention: crossing a warning threshold,
 * hitting the limit, and the limit changing. The server cannot raise toasts,
 * and it runs one instance per project location, so this is the one place
 * each popup is shown exactly once.
 *
 * Toasts fire on transitions between polls, never on the first reading of a
 * session, so opening a session that is already over budget stays quiet.
 */
export function budgetToasts(ctx) {
  let session
  let lastLimit
  let lastRatio
  return (sessionID, spent, limit) => {
    const ratio = Number.isFinite(limit) && limit > 0 ? spent / limit : null
    const show = (variant, title, message) => ctx.ui.toast.show({ variant, title, message, sessionID })

    if (sessionID !== session) {
      session = sessionID
    } else if (limit !== lastLimit) {
      show("success", "Budget", `Limit ${formatLimit(limit)}, ${currency.format(spent)} spent.`)
    } else if (ratio !== null && ratio >= 1 && (lastRatio ?? 0) < 1) {
      show(
        "error",
        "Budget limit reached",
        `${currency.format(spent)} of ${formatLimit(limit)}. Raise it with /budget <amount>, or /budget off.`,
      )
    } else if (ratio !== null) {
      const crossed = WARN_AT.filter((t) => ratio >= t && (lastRatio ?? 0) < t).pop()
      if (crossed) {
        show(
          "warning",
          "Budget",
          `${Math.round(ratio * 100)}% used: ${currency.format(spent)} of ${formatLimit(limit)}.`,
        )
      }
    }
    lastLimit = limit
    lastRatio = ratio
  }
}
