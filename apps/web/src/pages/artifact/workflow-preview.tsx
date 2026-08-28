import type { Artifact } from "@/api"
import { Eyebrow } from "@/components/shared/section-eyebrow"
import { SectionHeading, SectionTitle } from "@/components/shared/section-title"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { WorkflowRunHistory } from "./workflow-run-history"

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
      <Eyebrow
        as="h3"
        className={cn(
          tone === "pause" && "text-warning",
          tone === "effect" && "text-insights",
          tone === "limit" && "text-destructive",
        )}
      >
        {title}
      </Eyebrow>
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

export const workflowTriggerLabel = (startsWhen: string): string => {
  if (startsWhen === "explicit run") return "Starts when you run this workflow"
  if (startsWhen.endsWith(" completes")) return `After ${startsWhen}`
  return `When ${startsWhen}`
}

const RunPath = ({ diagram }: { diagram: PreviewDiagram }) => (
  <section className="min-w-0">
    <SectionTitle>The run</SectionTitle>
    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
      One Agent session per step attempt. Later steps start only when their stated condition is met.
    </p>
    {diagram.context_sessions.length ? (
      <ol className="mt-3 grid gap-2">
        {diagram.context_sessions.map((session, index) => {
          return (
            <li
              key={session.node_id}
              className="flex min-w-0 gap-3 rounded-lg border border-border-soft bg-background/45 p-3"
            >
              <span className="grid size-6 shrink-0 place-items-center rounded-full bg-primary/10 font-mono text-2xs font-medium text-primary">
                {index + 1}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="break-words text-sm font-medium text-foreground">
                    {session.label}
                  </span>
                  <span className="max-w-full break-all rounded-md bg-muted/60 px-1.5 py-0.5 font-mono text-2xs text-muted-foreground">
                    {session.context_ref}
                  </span>
                </div>
                <div className="mt-1 break-words text-xs leading-relaxed text-foreground">
                  Produces: {session.result}
                </div>
                <div className="mt-1 break-words text-2xs text-muted-foreground">
                  {workflowTriggerLabel(session.starts_when)}
                </div>
              </div>
            </li>
          )
        })}
      </ol>
    ) : (
      <p className="mt-3 rounded-lg border border-border-soft bg-background/45 p-3 text-xs text-muted-foreground">
        This workflow completes without delegating a step to an Agent.
      </p>
    )}
  </section>
)

const RunConsiderations = ({ diagram }: { diagram: PreviewDiagram }) => (
  <aside className="min-w-0 rounded-lg border border-border-soft bg-muted/20 p-4">
    <SectionTitle>Things to know</SectionTitle>
    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
      The choices, pauses, and limits that can change the path.
    </p>
    <div className="mt-4 grid gap-4">
      <Section title="Can take another route" items={diagram.may_do} />
      {diagram.will_pause.length ? (
        <Section title="Will ask a person" items={diagram.will_pause} tone="pause" />
      ) : (
        <div className="flex items-center gap-2 text-xs text-success">
          <span aria-hidden="true" className="size-1.5 rounded-full bg-success" />
          No human pauses
        </div>
      )}
      <Section title="Repeat limit" items={diagram.can_repeat} tone="pause" />
      <Section title="Writes and other effects" items={diagram.side_effects} tone="effect" />
    </div>
  </aside>
)

const ScenarioChecks = ({ scenarios }: { scenarios: PreviewDiagram["scenarios"] }) => {
  if (!scenarios.length) return null
  return (
    <details className="px-4 pb-4 sm:px-5">
      <summary className="cursor-pointer text-xs font-medium text-foreground">
        Checks passed · {scenarios.length} scenario{scenarios.length === 1 ? "" : "s"}
      </summary>
      <div className="mt-3 grid gap-2 md:grid-cols-3">
        {scenarios.map((scenario) => (
          <div
            key={`${scenario.kind}-${scenario.outcome}`}
            className="rounded-lg border border-border-soft p-3"
          >
            <Eyebrow as="div">{scenario.kind}</Eyebrow>
            <div className="mt-1 break-words text-xs leading-relaxed text-foreground">
              {scenario.outcome}
            </div>
          </div>
        ))}
      </div>
    </details>
  )
}

const DiagramPreview = ({
  shortId,
  diagram,
  showRuns,
  onRun,
}: {
  shortId: string
  diagram: PreviewDiagram
  showRuns: boolean
  onRun?: (diagramId: string) => void
}) => (
  <article
    className="overflow-hidden rounded-xl border border-border bg-card"
    data-testid={`workflow-preview-diagram-${diagram.id}`}
  >
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border-soft px-4 py-3 sm:px-5">
      <div className="min-w-0">
        <Eyebrow as="div" className="text-primary">
          Workflow
        </Eyebrow>
        <SectionTitle as="h2" className="mt-1">
          {diagram.title}
        </SectionTitle>
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
    <div className="grid gap-5 p-4 sm:p-5 xl:grid-cols-[minmax(0,1.45fr)_minmax(18rem,0.75fr)]">
      <RunPath diagram={diagram} />
      <RunConsiderations diagram={diagram} />
    </div>
    <ScenarioChecks scenarios={diagram.scenarios} />
    {showRuns ? (
      <WorkflowRunHistory shortId={shortId} diagramId={diagram.id} diagramTitle={diagram.title} />
    ) : null}
  </article>
)

/** The shared, non-executing gate. It intentionally reads like a receipt rather
 * than a configuration form: a teammate can understand the workflow cold, then
 * inspect live state or the exact graph only when they need to. */
export function WorkflowPreview({
  shortId,
  preview,
  showRuns,
  onRun,
}: {
  shortId: string
  preview: WorkflowPreviewValue
  showRuns: boolean
  onRun?: (diagramId: string) => void
}) {
  const ready = preview.status === "ready"
  const stepCount = preview.diagrams.reduce(
    (count, diagram) => count + diagram.context_sessions.length,
    0,
  )
  const pauseCount = preview.diagrams.reduce(
    (count, diagram) => count + diagram.will_pause.length,
    0,
  )
  const loopCount = preview.diagrams.reduce(
    (count, diagram) => count + diagram.can_repeat.length,
    0,
  )
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
              "inline-flex items-center gap-2 rounded-full border px-2.5 py-1 font-mono text-2xs font-medium",
              ready
                ? "border-success/25 bg-success/10 text-success"
                : "border-destructive/25 bg-destructive/10 text-destructive",
            )}
          >
            <span className={cn("size-2 rounded-full", ready ? "bg-success" : "bg-destructive")} />
            {ready ? "Ready to run" : "Needs changes"}
          </span>
          <span className="text-xs text-muted-foreground">Preview only · nothing has started</span>
        </div>
        <SectionHeading as="h2" className="mt-3">
          {ready ? "Review the run before it starts" : "Fix these blockers before run"}
        </SectionHeading>
        {preview.purpose ? (
          <p className="mt-1 max-w-3xl text-sm leading-relaxed text-muted-foreground">
            {preview.purpose}
          </p>
        ) : null}
        {ready ? (
          <div className="mt-3 flex flex-wrap gap-2 text-2xs text-muted-foreground">
            <span className="rounded-md border border-border-soft bg-background/40 px-2 py-1">
              {stepCount} agent step{stepCount === 1 ? "" : "s"}
            </span>
            <span className="rounded-md border border-border-soft bg-background/40 px-2 py-1">
              {pauseCount
                ? `${pauseCount} human pause${pauseCount === 1 ? "" : "s"}`
                : "No human pauses"}
            </span>
            {loopCount ? (
              <span className="rounded-md border border-border-soft bg-background/40 px-2 py-1">
                {loopCount} bounded loop{loopCount === 1 ? "" : "s"}
              </span>
            ) : null}
          </div>
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
        <DiagramPreview
          key={diagram.id}
          shortId={shortId}
          diagram={diagram}
          showRuns={showRuns}
          onRun={ready ? onRun : undefined}
        />
      ))}

      {preview.cannot_do.length ? (
        <div className="rounded-xl border border-destructive/25 bg-card p-4 sm:p-5">
          <Section title="Will not do" items={preview.cannot_do} tone="limit" />
        </div>
      ) : null}
    </div>
  )
}
