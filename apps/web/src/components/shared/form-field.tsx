import {
  cloneElement,
  Fragment,
  isValidElement,
  type ReactElement,
  type ReactNode,
  useId,
} from "react"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"

// The one form row: a label above its control, plus optional helper text. Composes
// the Label primitive so every form shares one label register instead of hand-
// rolling <label> markup. Pass `htmlFor` matching the control's id for association.
// An error takes the hint's line (one message per row, destructive register).
//
// The message is WIRED, not just stacked (the shadcn Field direction / WAI forms
// guidance): the hint/error paragraph gets an id and, when the child is a single
// element, the control is cloned with aria-describedby — plus aria-invalid while
// an error shows. Explicit aria-* props on the child always win.
export function FormField({
  label,
  htmlFor,
  hint,
  error,
  count,
  maxLength,
  children,
  className,
}: {
  label: ReactNode
  htmlFor?: string
  hint?: ReactNode
  error?: ReactNode
  /** With `maxLength`, renders a live `count/maxLength` meter by the label that warns as
   *  the field nears its cap — so a `maxLength` truncation is never silent. */
  count?: number
  maxLength?: number
  children: ReactNode
  className?: string
}) {
  const uid = useId()
  const base = htmlFor ?? uid
  const messageId = error ? `${base}-error` : hint ? `${base}-hint` : undefined

  let control: ReactNode = children
  if (messageId && isValidElement(children) && children.type !== Fragment) {
    const existing = children.props as { "aria-describedby"?: string; "aria-invalid"?: unknown }
    control = cloneElement(children as ReactElement<Record<string, unknown>>, {
      // MERGE, don't replace: aria-describedby is a space-separated id LIST, so a control that
      // already points at (say) password rules must keep that AND gain the error/hint id —
      // replacing it would drop the error from the accessibility tree.
      "aria-describedby":
        [existing["aria-describedby"], messageId].filter(Boolean).join(" ") || undefined,
      ...(error && existing["aria-invalid"] === undefined ? { "aria-invalid": true } : {}),
    })
  }

  // A live length meter for capped fields: muted, warns in the last 10%, destructive at the
  // cap. The visible number is decorative (aria-hidden) so it doesn't announce on every
  // keystroke; an sr-only live region (below) gives assistive tech the same warning, but only
  // once near the cap — so a length limit is never silent for sighted OR screen-reader users.
  const hasCounter = Number.isFinite(count) && Number.isFinite(maxLength)
  const nearLimit = hasCounter && (count as number) >= (maxLength as number) * 0.9
  const counter = hasCounter ? (
    <span
      aria-hidden
      className={cn(
        "text-xs tabular-nums",
        (count as number) >= (maxLength as number)
          ? "text-destructive"
          : nearLimit
            ? "text-warning"
            : "text-muted-foreground",
      )}
    >
      {count}/{maxLength}
    </span>
  ) : null

  return (
    <div className={cn("grid gap-2", className)}>
      {counter ? (
        <div className="flex items-baseline justify-between gap-2">
          <Label htmlFor={htmlFor}>{label}</Label>
          {counter}
        </div>
      ) : (
        <Label htmlFor={htmlFor}>{label}</Label>
      )}
      {control}
      {/* Persistent (so SRs announce its changes) but silent until near the cap: the count
          is only worth speaking once it starts to matter. */}
      {hasCounter && (
        <span className="sr-only" role="status">
          {nearLimit
            ? (maxLength as number) - (count as number) > 0
              ? `${(maxLength as number) - (count as number)} characters left`
              : "You've reached the character limit"
            : ""}
        </span>
      )}
      {error ? (
        <p id={messageId} className="text-sm text-destructive">
          {error}
        </p>
      ) : hint ? (
        <p id={messageId} className="text-sm text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  )
}
