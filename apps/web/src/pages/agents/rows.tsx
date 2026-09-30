import type { ReactNode } from "react"
import { Icon, type IconName } from "@/components/icons"
import { cn } from "@/lib/utils"
import type { MachineMark } from "./format"

// The one row the agent screens are built from: a state glyph, the title, one grey line,
// and metadata hard right. One line, 52px, hairline between rows. A group is a quiet
// uppercase label over its rows; an empty group is not drawn at all.

export function Group({
  label,
  testId,
  children,
}: {
  /** Omitted where the page title already names the list. */
  label?: string
  testId: string
  children: ReactNode
}) {
  return (
    <section data-testid={testId} className="flex flex-col">
      {label && (
        <h2 className="mb-1.5 text-sm font-medium tracking-wider text-muted-foreground uppercase">
          {label}
        </h2>
      )}
      <div className="flex flex-col">{children}</div>
    </section>
  )
}

/** The row's inner line. The caller supplies the element (a Link, a button, a div). */
export function RowLine({
  icon,
  tone,
  title,
  detail,
}: {
  icon: IconName
  tone?: "warning" | "destructive"
  title: ReactNode
  detail?: ReactNode
}) {
  return (
    <>
      <Icon
        name={icon}
        size={18}
        strokeWidth={1.75}
        className={cn(
          "text-muted-foreground",
          tone === "warning" && "text-warning",
          tone === "destructive" && "text-destructive",
          icon === "job-running" && "motion-safe:animate-spin",
        )}
      />
      <span className="flex min-w-0 flex-1 items-baseline gap-2.5 overflow-hidden whitespace-nowrap">
        <span className="truncate font-medium text-foreground">{title}</span>
        {detail && (
          <span
            className={cn(
              "truncate text-muted-foreground max-sm:hidden",
              tone === "warning" && "text-foreground",
            )}
          >
            {detail}
          </span>
        )}
      </span>
    </>
  )
}

/** Row chrome: 52px, hairline under every row but the last; the needs-you wash. */
export const rowClass = (tone?: "warning") =>
  cn(
    "flex h-13 items-center gap-3.5 border-b border-border text-base last:border-b-0",
    tone === "warning" && "-mx-3 rounded-lg border-b-0 bg-warning/10 px-3",
  )

/** The right-hand cluster: small grey words, times in mono. */
export function Meta({ children }: { children: ReactNode }) {
  return (
    <span className="flex shrink-0 items-center gap-5 text-sm text-muted-foreground max-sm:gap-3">
      {children}
    </span>
  )
}

export const Time = ({ children, title }: { children: ReactNode; title?: string }) => (
  <span className="font-mono" title={title}>
    {children}
  </span>
)

/** Where it runs, with a filled dot when that machine is answering and a hollow one when not. */
export function Machine({ mark }: { mark: MachineMark }) {
  return (
    <span className="flex items-center gap-1.5">
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 rounded-full",
          mark.on ? "bg-success" : "border border-muted-foreground",
        )}
      />
      {mark.label}
    </span>
  )
}
