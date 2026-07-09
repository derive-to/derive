import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

// Field-level message wired to its control — the house way to attach validation feedback to an
// INLINE / grouped / unlabelled input where FormField (a labelled vertical block) doesn't fit
// (`FormField error/hint` is the equivalent for a plain labelled field).
//
// One call yields both halves so they can't drift: spread `.aria` onto the control and render
// `.node` right after it. With a `message` it's an ERROR (aria-invalid + a role="alert" line);
// with only a `hint` it's guidance (described, muted, no alert) — EITHER way it's associated,
// so a screen reader gets the reason (or the requirement up front), never a bare "invalid" or a
// silent red field. check-forms.mjs backstops the HAND-ROLLED case (a literal aria-invalid that
// forgets the pairing); this primitive and FormField guarantee it by construction.
export function fieldError(id: string, message?: ReactNode, hint?: ReactNode) {
  const set = (v: ReactNode) => v != null && v !== false && v !== ""
  const isError = set(message)
  const text = isError ? message : hint
  return {
    aria: set(text) ? { "aria-describedby": id, ...(isError ? { "aria-invalid": true } : {}) } : {},
    node: set(text) ? (
      <p
        id={id}
        data-testid={id}
        role={isError ? "alert" : undefined}
        className={cn("text-sm", isError ? "text-destructive" : "text-muted-foreground")}
      >
        {text}
      </p>
    ) : null,
  }
}
