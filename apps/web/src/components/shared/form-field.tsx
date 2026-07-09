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
      "aria-describedby": existing["aria-describedby"] ?? messageId,
      ...(error && existing["aria-invalid"] === undefined ? { "aria-invalid": true } : {}),
    })
  }

  // A live length meter for capped fields: muted, warns in the last 10%, destructive at
  // the cap — decorative (aria-hidden), so it doesn't announce on every keystroke.
  const counter =
    typeof count === "number" && typeof maxLength === "number" ? (
      <span
        aria-hidden
        className={cn(
          "text-xs tabular-nums",
          count >= maxLength
            ? "text-destructive"
            : count >= maxLength * 0.9
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
