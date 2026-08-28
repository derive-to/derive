import { ChevronRight } from "lucide-react"
import { type ReactNode, useState } from "react"
import { ago } from "@/lib/time"
import { cn } from "@/lib/utils"
import { StatusBadge, type StatusTone } from "./status-badge"

export type RunDisplayStatus =
  | "queued"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "cancelled"

export const runStatusLabel = (status: RunDisplayStatus): string =>
  ({
    queued: "Queued",
    running: "Running",
    waiting: "Waiting",
    succeeded: "Completed",
    failed: "Failed",
    cancelled: "Cancelled",
  })[status]

export const runStatusTone = (status: RunDisplayStatus): StatusTone => {
  if (status === "succeeded") return "ok"
  if (status === "failed") return "error"
  if (status === "running") return "busy"
  if (status === "waiting") return "attention"
  return "muted"
}

export function RunReceipt({
  id,
  status,
  title,
  summary,
  facts,
  createdAt,
  defaultOpen = false,
  children,
  testId,
}: {
  id: string
  status: RunDisplayStatus
  title: string
  summary: string
  facts: string[]
  createdAt: string
  defaultOpen?: boolean
  children?: ReactNode
  testId?: string
}) {
  const [open, setOpen] = useState(defaultOpen)
  const header = (
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone={runStatusTone(status)} shape="pill">
          {runStatusLabel(status)}
        </StatusBadge>
        <span className="min-w-0 truncate text-sm font-medium text-foreground">{title}</span>
        <span className="font-mono text-2xs text-muted-foreground">{id.slice(-8)}</span>
        <span className="ml-auto shrink-0 font-mono text-2xs text-muted-foreground">
          {ago(createdAt)}
        </span>
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{summary}</p>
      {facts.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 font-mono text-2xs text-muted-foreground">
          {facts.map((fact) => (
            <span key={fact}>{fact}</span>
          ))}
        </div>
      ) : null}
    </div>
  )

  return (
    <article
      data-testid={testId}
      className={cn("rounded-lg border border-border-soft bg-card", open && "bg-muted/10")}
    >
      {children ? (
        <details
          open={open}
          onToggle={(event) => setOpen(event.currentTarget.open)}
          className="group"
        >
          <summary className="flex cursor-pointer list-none gap-3 px-3 py-3 marker:hidden [&::-webkit-details-marker]:hidden">
            {header}
            <ChevronRight
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
            />
          </summary>
          <div className="border-t border-border-soft px-3 py-3">{children}</div>
        </details>
      ) : (
        <div className="px-3 py-3">{header}</div>
      )}
    </article>
  )
}
