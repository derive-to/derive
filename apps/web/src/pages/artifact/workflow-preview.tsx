import type { Artifact } from "@/api"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

type WorkflowPreviewValue = NonNullable<Artifact["workflow_preview"]>
type PreviewDiagram = WorkflowPreviewValue["diagrams"][number]

const Section = ({
  title,
  items,
  tone = "default",
}: {
  title: string
  items: string[]
  tone?: "default" | "pause" | "effect" | "limit"
}) => {
  if (!items.length) return null
  return (
    <section className="min-w-0">
      <h3
        className={cn(
          "font-mono text-2xs font-semibold uppercase tracking-[0.11em] text-muted-foreground",
          tone === "pause" && "text-warning",
          tone === "effect" && "text-insights",
          tone === "limit" && "text-destructive",
        )}
      >
        {title}
      </h3>
      <ul className="mt-2 grid gap-2">
        {items.map((item) => (
          <li key={item} className="flex min-w-0 gap-2 text-sm leading-relaxed text-foreground">
            <span
              aria-hidden="true"
              className={cn(
                "mt-2 size-1.5 shrink-0 rounded-full bg-muted-foreground/60",
                tone === "pause" && "bg-warning",
                tone === "effect" && "bg-insights",
                tone === "limit" && "bg-destructive",
              )}
            />
            <span className="min-w-0 break-words">{item}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

const DiagramPreview = ({
  diagram,
  onRun,
}: {
  diagram: PreviewDiagram
  onRun?: (diagramId: string) => void
}) => (
  <article
    className="overflow-hidden rounded-xl border border-border bg-card"
    data-testid={`workflow-preview-diagram-${diagram.id}`}
  >
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border-soft px-4 py-3 sm:px-5">
      <div className="min-w-0">
        <div className="font-mono text-2xs uppercase tracking-[0.12em] text-primary">Workflow</div>
        <h2 className="mt-1 break-words text-base font-semibold text-foreground">
          {diagram.title}
        </h2>
      </div>
      {onRun ? (
        <Button
          size="sm"
          data-testid={`workflow-run-${diagram.id}`}
          onClick={() => onRun(diagram.id)}
        >
          Run with my agent
        </Button>
      ) : null}
    </header>
    <div className="grid gap-5 p-4 sm:grid-cols-2 sm:p-5 xl:grid-cols-3">
      <Section title="Will do" items={diagram.will_do} />
      <Section title="May branch" items={diagram.may_do} />
      <Section title="Will pause" items={diagram.will_pause} tone="pause" />
      <Section title="Can repeat" items={diagram.can_repeat} tone="pause" />
      <Section title="External effects" items={diagram.side_effects} tone="effect" />
      {diagram.context_sessions.length ? (
        <section className="min-w-0">
          <h3 className="font-mono text-2xs font-semibold uppercase tracking-[0.11em] text-muted-foreground">
            Contexts on run
          </h3>
          <ul className="mt-2 grid gap-2">
            {diagram.context_sessions.map((session) => (
              <li key={session.node_id} className="min-w-0 rounded-lg bg-muted/40 px-3 py-2">
                <div className="break-words text-sm font-medium text-foreground">
                  {session.label}
                </div>
                <div className="mt-0.5 break-all font-mono text-2xs text-muted-foreground">
                  {session.context_ref} · {session.starts_when}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {diagram.scenarios.length ? (
        <section className="min-w-0 sm:col-span-2 xl:col-span-3">
          <h3 className="font-mono text-2xs font-semibold uppercase tracking-[0.11em] text-muted-foreground">
            Scenarios checked
          </h3>
          <div className="mt-2 grid gap-2 md:grid-cols-3">
            {diagram.scenarios.map((scenario) => (
              <div
                key={`${scenario.kind}-${scenario.outcome}`}
                className="rounded-lg border border-border p-3"
              >
                <div className="font-mono text-2xs uppercase text-muted-foreground">
                  {scenario.kind}
                </div>
                <div className="mt-1 break-words text-xs leading-relaxed text-foreground">
                  {scenario.outcome}
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  </article>
)

/** The shared, non-executing gate. It intentionally reads like a receipt rather
 * than a configuration form: a teammate can understand the workflow cold, then
 * inspect live state or the exact graph only when they need to. */
export function WorkflowPreview({
  preview,
  onRun,
}: {
  preview: WorkflowPreviewValue
  onRun?: (diagramId: string) => void
}) {
  const ready = preview.status === "ready"
  return (
    <div className="grid gap-4" data-testid="workflow-preview">
      <section
        className={cn(
          "rounded-xl border p-4 sm:p-5",
          ready ? "border-success/30 bg-success/5" : "border-destructive/30 bg-destructive/5",
        )}
      >
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              "inline-flex items-center gap-2 rounded-full border px-2.5 py-1 font-mono text-2xs font-semibold uppercase tracking-[0.08em]",
              ready
                ? "border-success/25 bg-success/10 text-success"
                : "border-destructive/25 bg-destructive/10 text-destructive",
            )}
          >
            <span className={cn("size-2 rounded-full", ready ? "bg-success" : "bg-destructive")} />
            {ready ? "Ready" : "Needs changes"}
          </span>
          <span className="text-xs text-muted-foreground">Preview only · nothing has started</span>
        </div>
        <h2 className="mt-3 text-lg font-semibold text-foreground">
          {ready ? "What will happen when your agent runs this" : "Fix these blockers before run"}
        </h2>
        {preview.purpose ? (
          <p className="mt-1 max-w-3xl text-sm leading-relaxed text-muted-foreground">
            {preview.purpose}
          </p>
        ) : null}
        {preview.errors.length ? (
          <ul className="mt-4 grid gap-2">
            {[...new Set(preview.errors)].map((error) => (
              <li key={error} className="break-words font-mono text-xs text-destructive">
                {error}
              </li>
            ))}
          </ul>
        ) : null}
        {preview.warnings.length ? (
          <ul className="mt-4 grid gap-2">
            {[...new Set(preview.warnings)].map((warning) => (
              <li key={warning} className="break-words text-xs text-warning">
                {warning}
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      {preview.diagrams.map((diagram) => (
        <DiagramPreview key={diagram.id} diagram={diagram} onRun={ready ? onRun : undefined} />
      ))}

      {preview.cannot_do.length ? (
        <div className="rounded-xl border border-destructive/25 bg-card p-4 sm:p-5">
          <Section title="Will not do" items={preview.cannot_do} tone="limit" />
        </div>
      ) : null}
    </div>
  )
}
