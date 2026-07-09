import type { ReactNode } from "react"

// Field-level validation feedback, wired to its control. The house way to attach a message to
// an INLINE / grouped / unlabelled input where FormField (a labelled vertical block) doesn't
// fit — `FormField error={…}` is the equivalent for a plain labelled field.
//
// One call yields both halves so they can't drift: spread `.aria` onto the control (it sets
// aria-invalid + aria-describedby ONLY when there's a message) and render `.node` right after
// it (a role="alert" message carrying the matching id). So a screen reader never announces
// "invalid" without the reason, and a sighted user never sees a red field with no explanation
// — the invariant scripts/check-forms.mjs enforces app-wide.
export function fieldError(id: string, message?: ReactNode) {
  const has = message != null && message !== false && message !== ""
  return {
    aria: has ? { "aria-invalid": true, "aria-describedby": id } : {},
    node: has ? (
      <p id={id} data-testid={id} role="alert" className="text-sm text-destructive">
        {message}
      </p>
    ) : null,
  }
}
