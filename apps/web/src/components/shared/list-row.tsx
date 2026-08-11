import type { ComponentPropsWithoutRef, ReactNode } from "react"
import { cn } from "@/lib/utils"

// The one list row: an item and its actions — the sibling of SettingRow (a label
// and its control). Members, agents, webhooks, domains, repos, passkeys, plans:
// all the same anatomy, so it is drawn once. Leading slot for an avatar or badge,
// a title over one quiet meta line, a trailing action cluster (ghost verbs,
// destructive-ghost always LAST, never a filled button), and an optional `below`
// lane for what expands out of the row — a delivery log, a lend toggle, a
// one-time token. Rows stack inside a hairline-divided SettingsGroup at py-3.5,
// the same height as SettingRow; the list skeleton renders THIS component, so
// the placeholder can never drift from the real row again.
export function ListRow({
  leading,
  title,
  mono = false,
  meta,
  actions,
  below,
  className,
  ...rest
}: {
  /** Avatar, badge, or glyph before the text block. Sized by the caller. */
  leading?: ReactNode
  title: ReactNode
  /** Machine-made titles (a URL, a host, an id) render mono instead of medium. */
  mono?: boolean
  /** One quiet line under the title; mono spans inside for machine facts. */
  meta?: ReactNode
  /** The trailing cluster. Verbs are ghost; the destructive one is last. */
  actions?: ReactNode
  /** Full-width content under the row line (an expanded log, a token reveal). */
  below?: ReactNode
} & Omit<ComponentPropsWithoutRef<"div">, "title">) {
  return (
    <div {...rest} className={cn("flex flex-col gap-2 py-3.5", className)}>
      <div className="flex items-center gap-3">
        {leading}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div
            className={cn(
              "text-sm text-foreground",
              mono ? "truncate font-mono" : "font-medium",
              !mono && typeof title === "string" && "truncate",
            )}
          >
            {title}
          </div>
          {meta != null && (
            <div
              className={cn(
                "text-2xs text-muted-foreground",
                typeof meta === "string" && "truncate",
              )}
            >
              {meta}
            </div>
          )}
        </div>
        {actions && (
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">{actions}</div>
        )}
      </div>
      {below}
    </div>
  )
}
