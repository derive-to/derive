import { useMemo } from "react"
import type { Artifact } from "@/api"
import { cn } from "@/lib/utils"
import {
  type LinkedBundleWorkflowNode,
  linkedBundleNodeExplanation,
} from "./linked-bundle-node-details"
import { linkedBundleNodeStateDot } from "./linked-bundle-node-state"
import { linkedBundleEffectiveTier } from "./linked-bundle-panel"

type LinkedBundle = NonNullable<Artifact["linked_bundle"]>
type Diagram = NonNullable<LinkedBundle["diagrams"]>[number]
type DiagramNode = Diagram["nodes"][number]
type BundleMember = LinkedBundle["members"][number]

export const linkedBundleCurrentNodes = (diagram: Diagram): DiagramNode[] =>
  diagram.nodes.filter(
    (node) => node.state === "active" || node.state === "waiting" || node.state === "blocked",
  )

/** Authored node state is the execution receipt. An untouched workflow starts in
 * Preview; once any node moves beyond pending, current run state takes priority. */
export const linkedBundleHasRunState = (diagrams: Diagram[]): boolean =>
  diagrams.some((diagram) =>
    diagram.nodes.some((node) => node.state !== undefined && node.state !== "pending"),
  )

export const linkedBundleInitialView = (
  diagrams: Diagram[],
  hasWorkflowPreview: boolean,
): "preview" | "now" =>
  hasWorkflowPreview && !linkedBundleHasRunState(diagrams) ? "preview" : "now"

export type LinkedBundleNowReference = {
  diagram: string
  node: string
}

export type LinkedBundleNowSummary = {
  current: LinkedBundleNowReference[]
  needsHelp: LinkedBundleNowReference[]
  next: LinkedBundleNowReference[]
  done: number
  total: number
}

export const linkedBundleNowHeadline = (summary: LinkedBundleNowSummary): string => {
  if (summary.needsHelp.length)
    return `${summary.needsHelp.length} ${summary.needsHelp.length === 1 ? "item needs" : "items need"} your help.`
  if (summary.current.length)
    return `${summary.current.length} ${summary.current.length === 1 ? "work item is" : "work items are"} moving. No agent has asked for help.`
  if (summary.total > 0 && summary.done === summary.total) return "Run complete."
  return "No active work is reported right now."
}

/** Project the precise graph into the few questions a returning human asks first.
 * The graph remains canonical; this summary never invents state or ordering. */
export const linkedBundleNowSummary = (diagrams: Diagram[]): LinkedBundleNowSummary => {
  const current: LinkedBundleNowReference[] = []
  const needsHelp: LinkedBundleNowReference[] = []
  const next: LinkedBundleNowReference[] = []
  const nextKeys = new Set<string>()
  let done = 0
  let total = 0

  for (const diagram of diagrams) {
    total += diagram.nodes.length
    const byId = new Map(diagram.nodes.map((node) => [node.id, node]))
    const currentIds = new Set<string>()
    for (const node of diagram.nodes) {
      if (node.state === "done") done += 1
      if (node.state === "active" || node.state === "waiting" || node.state === "blocked") {
        const reference = { diagram: diagram.id, node: node.id }
        current.push(reference)
        currentIds.add(node.id)
        if (node.help?.needed) needsHelp.push(reference)
      }
    }
    for (const edge of diagram.edges) {
      if (!currentIds.has(edge.from)) continue
      const target = byId.get(edge.to)
      if (!target || (target.state && target.state !== "pending")) continue
      const key = `${diagram.id}:${target.id}`
      if (nextKeys.has(key)) continue
      nextKeys.add(key)
      next.push({ diagram: diagram.id, node: target.id })
    }
  }

  return { current, needsHelp, next, done, total }
}

const stateChipTone = (state?: DiagramNode["state"]): string => {
  if (state === "done") return "border-success/25 bg-success/10 text-success"
  if (state === "active") return "border-insights/25 bg-insights/10 text-insights"
  if (state === "waiting") return "border-warning/25 bg-warning/10 text-warning"
  if (state === "blocked") return "border-destructive/25 bg-destructive/10 text-destructive"
  return "border-border bg-muted/45 text-muted-foreground"
}

export function LinkedBundleNowWorkspace({
  diagrams,
  members,
  workflowNodes,
  onFocus,
}: {
  diagrams: Diagram[]
  members: Map<string, BundleMember>
  workflowNodes: Map<string, LinkedBundleWorkflowNode>
  onFocus: (target: { diagram: string; local: string }) => void
}) {
  const summary = useMemo(() => linkedBundleNowSummary(diagrams), [diagrams])
  const diagramById = useMemo(
    () => new Map(diagrams.map((diagram) => [diagram.id, diagram])),
    [diagrams],
  )
  const helpKeys = new Set(summary.needsHelp.map((item) => `${item.diagram}:${item.node}`))
  const moving = summary.current.filter((item) => !helpKeys.has(`${item.diagram}:${item.node}`))
  const resolve = (reference: LinkedBundleNowReference) => {
    const diagram = diagramById.get(reference.diagram)
    const node = diagram?.nodes.find((item) => item.id === reference.node)
    if (!diagram || !node) return null
    return { diagram, node, member: node.member ? members.get(node.member) : undefined }
  }

  const nodeButton = (
    reference: LinkedBundleNowReference,
    treatment: "current" | "help" | "next",
  ) => {
    const resolved = resolve(reference)
    if (!resolved) return null
    const { diagram, node, member } = resolved
    const tier = linkedBundleEffectiveTier(node, diagram)
    const explanation = linkedBundleNodeExplanation(
      diagram,
      node,
      workflowNodes.get(`${diagram.id}:${node.id}`),
    )
    return (
      <button
        key={`${diagram.id}:${node.id}`}
        type="button"
        data-testid={`bundle-now-${treatment}-${diagram.id}-${node.id}`}
        onClick={() => onFocus({ diagram: diagram.id, local: node.id })}
        className={cn(
          "rounded-xl border p-4 text-left transition-colors hover:border-primary/40 hover:bg-muted/25",
          treatment === "help"
            ? "border-destructive/35 bg-destructive/5"
            : treatment === "current"
              ? "border-insights/30 bg-insights/5"
              : "border-border bg-card",
        )}
      >
        <span className="flex items-start justify-between gap-3">
          <span className="min-w-0">
            <span className="font-mono text-2xs uppercase tracking-[0.1em] text-muted-foreground">
              {diagram.title}
            </span>
            <span className="mt-1 block text-sm font-semibold text-foreground">{node.label}</span>
          </span>
          <span className="shrink-0 text-2xs text-muted-foreground">Open in Advanced →</span>
        </span>
        <span className="mt-1.5 block text-xs leading-relaxed text-muted-foreground">
          {treatment === "help"
            ? node.help?.question
            : (explanation.whatHappens ?? member?.label ?? "No additional detail stated")}
        </span>
        {treatment === "help" && node.help?.can_continue ? (
          <span className="mt-2 block text-2xs text-muted-foreground">
            Can continue: {node.help.can_continue}
          </span>
        ) : null}
        <span className="mt-3 flex flex-wrap items-center gap-1.5 font-mono text-2xs">
          {node.state ? (
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 capitalize",
                stateChipTone(node.state),
              )}
            >
              <span className={cn("size-1.5 rounded-full", linkedBundleNodeStateDot(node.state))} />
              {node.state}
            </span>
          ) : null}
          {tier ? (
            <span className="rounded-md border border-border bg-muted/35 px-1.5 py-0.5 text-muted-foreground">
              tier {tier}
            </span>
          ) : null}
          {node.confidence ? (
            <span
              className={cn(
                "rounded-md border px-1.5 py-0.5 capitalize",
                node.confidence.level === "high"
                  ? "border-success/20 bg-success/10 text-success"
                  : node.confidence.level === "low"
                    ? "border-warning/20 bg-warning/10 text-warning"
                    : "border-border bg-muted/35 text-muted-foreground",
              )}
            >
              {node.confidence.level} confidence
            </span>
          ) : null}
          {member ? (
            <span className="truncate rounded-md border border-share/15 bg-share/5 px-1.5 py-0.5 text-share">
              {member.label}
              {member.current_version ? ` · v${member.current_version}` : ""}
            </span>
          ) : null}
        </span>
      </button>
    )
  }

  const loops = diagrams.filter((diagram) => diagram.type === "loop")
  const topologyTitle = diagrams.every((diagram) => diagram.type === "graph")
    ? "Graph at a glance"
    : diagrams.every((diagram) => diagram.type === "loop")
      ? "Loop at a glance"
      : "Workflow shape"
  return (
    <div className="grid gap-5" data-testid="bundle-now-view">
      <section className="rounded-xl border border-border bg-card p-4 sm:p-6">
        <div className="font-mono text-2xs uppercase tracking-[0.12em] text-primary">Now</div>
        <h2 className="mt-2 max-w-3xl text-lg font-semibold tracking-tight text-foreground sm:text-2xl">
          {linkedBundleNowHeadline(summary)}
        </h2>
        <p className="mt-2 hidden max-w-3xl text-sm leading-relaxed text-muted-foreground sm:block">
          This briefing comes directly from authored graph state. Open any item in Advanced to
          inspect its exact relationships, confidence basis, or history.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-1.5 font-mono text-2xs">
          <span className="rounded-md border border-insights/20 bg-insights/10 px-1.5 py-0.5 text-insights">
            {summary.current.length} current
          </span>
          {summary.needsHelp.length ? (
            <span className="rounded-md border border-destructive/20 bg-destructive/10 px-1.5 py-0.5 font-semibold text-destructive">
              {summary.needsHelp.length} need you
            </span>
          ) : null}
          <span className="rounded-md border border-border bg-muted/40 px-1.5 py-0.5 text-muted-foreground">
            {summary.next.length} next
          </span>
          <span className="text-muted-foreground">
            {summary.done} of {summary.total} done
          </span>
        </div>
        <div className="mt-2 h-1.5 max-w-lg overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-success transition-[width]"
            style={{
              width: `${summary.total ? Math.round((summary.done / summary.total) * 100) : 0}%`,
            }}
          />
        </div>
      </section>

      {diagrams.length ? (
        <section data-testid="bundle-now-topology">
          <div className="mb-2">
            <h2 className="text-sm font-semibold text-foreground">{topologyTitle}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              A compact view of the authored topology. Open a relationship for the full canvas.
            </p>
          </div>
          <div className="grid gap-2">
            {diagrams.map((diagram) => {
              const labels = new Map(diagram.nodes.map((node) => [node.id, node.label]))
              return (
                <article
                  key={diagram.id}
                  className="rounded-xl border border-border bg-card p-4"
                  data-testid={`bundle-now-topology-${diagram.id}`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <div className="font-mono text-2xs uppercase tracking-[0.12em] text-primary">
                        {diagram.type} · {diagram.nodes.length}{" "}
                        {diagram.type === "loop" ? "steps" : "nodes"}
                      </div>
                      <h3 className="mt-1 text-sm font-semibold text-foreground">
                        {diagram.title}
                      </h3>
                    </div>
                    <span className="font-mono text-2xs text-muted-foreground">
                      {diagram.edges.length}{" "}
                      {diagram.type === "loop" ? "transitions" : "relationships"}
                    </span>
                  </div>
                  {diagram.edges.length ? (
                    <div className="mt-3 grid gap-2 sm:grid-cols-2">
                      {diagram.edges.slice(0, 6).map((edge, index) => (
                        <button
                          key={`${edge.from}:${edge.to}:${edge.label ?? ""}`}
                          type="button"
                          onClick={() => onFocus({ diagram: diagram.id, local: edge.to })}
                          className="flex min-w-0 items-center gap-2 rounded-lg border border-border-soft bg-muted/15 px-3 py-2 text-left text-xs transition-colors hover:border-primary/35 hover:bg-muted/30"
                          data-testid={`bundle-now-relationship-${diagram.id}-${index}`}
                        >
                          <span className="truncate font-medium text-foreground">
                            {labels.get(edge.from) ?? edge.from}
                          </span>
                          <span aria-hidden="true" className="shrink-0 text-primary">
                            →
                          </span>
                          <span className="truncate font-medium text-foreground">
                            {labels.get(edge.to) ?? edge.to}
                          </span>
                          {edge.label ? (
                            <span className="ml-auto shrink-0 text-2xs text-muted-foreground">
                              {edge.label}
                            </span>
                          ) : null}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {diagram.nodes.slice(0, 6).map((node) => (
                        <button
                          key={node.id}
                          type="button"
                          onClick={() => onFocus({ diagram: diagram.id, local: node.id })}
                          className="rounded-lg border border-border-soft bg-muted/15 px-3 py-2 text-xs font-medium text-foreground transition-colors hover:border-primary/35 hover:bg-muted/30"
                          data-testid={`bundle-now-node-${diagram.id}-${node.id}`}
                        >
                          {node.label}
                        </button>
                      ))}
                    </div>
                  )}
                  {diagram.edges.length > 6 ? (
                    <p className="mt-2 text-2xs text-muted-foreground">
                      +{diagram.edges.length - 6} more{" "}
                      {diagram.type === "loop" ? "transitions" : "relationships"} in Advanced
                    </p>
                  ) : null}
                </article>
              )
            })}
          </div>
        </section>
      ) : null}

      {summary.needsHelp.length ? (
        <section data-testid="bundle-now-needs-help">
          <div className="mb-2">
            <h2 className="text-sm font-semibold text-destructive">Needs you</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Only explicit agent help requests appear here.
            </p>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {summary.needsHelp.map((item) => nodeButton(item, "help"))}
          </div>
        </section>
      ) : null}

      {moving.length ? (
        <section>
          <div className="mb-2">
            <h2 className="text-sm font-semibold text-foreground">Current work</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Active, waiting, and blocked work—without the graph mechanics.
            </p>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {moving.map((item) => nodeButton(item, "current"))}
          </div>
        </section>
      ) : null}

      {summary.next.length ? (
        <section>
          <div className="mb-2">
            <h2 className="text-sm font-semibold text-foreground">Likely next</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Pending work directly downstream from what is current.
            </p>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {summary.next.map((item) => nodeButton(item, "next"))}
          </div>
        </section>
      ) : null}

      {loops.length ? (
        <section>
          <div className="mb-2">
            <h2 className="text-sm font-semibold text-foreground">Improvement attempts</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Loops read as goals, current attempts, and stop conditions here.
            </p>
          </div>
          <div className="grid gap-2 xl:grid-cols-2">
            {loops.map((loop) => {
              const current = linkedBundleCurrentNodes(loop)
              const complete =
                loop.nodes.length > 0 && loop.nodes.every((node) => node.state === "done")
              return (
                <article
                  key={loop.id}
                  className="rounded-xl border border-border bg-card p-4"
                  data-testid={`bundle-now-loop-${loop.id}`}
                >
                  <span className="flex items-start justify-between gap-3">
                    <span>
                      <span className="font-mono text-2xs uppercase tracking-[0.1em] text-muted-foreground">
                        Improvement loop
                      </span>
                      <span className="mt-1 block text-sm font-semibold text-foreground">
                        {loop.title}
                      </span>
                    </span>
                    <span
                      className={cn(
                        "shrink-0 rounded-md border px-1.5 py-0.5 font-mono text-2xs",
                        complete
                          ? "border-success/20 bg-success/10 text-success"
                          : current.length
                            ? "border-insights/20 bg-insights/10 text-insights"
                            : "border-border bg-muted/40 text-muted-foreground",
                      )}
                    >
                      {complete ? "complete" : current.length ? "in progress" : "not started"}
                    </span>
                  </span>
                  <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-3 xl:grid-cols-1 2xl:grid-cols-3">
                    <div>
                      <dt className="font-mono text-2xs uppercase text-muted-foreground">Goal</dt>
                      <dd className="mt-1 text-foreground">{loop.goal ?? "Not stated"}</dd>
                    </div>
                    <div>
                      <dt className="font-mono text-2xs uppercase text-muted-foreground">
                        Current attempt
                      </dt>
                      <dd className="mt-1 text-foreground">
                        {current.map((node) => node.label).join(", ") ||
                          (complete ? "Completed" : "Not stated")}
                      </dd>
                    </div>
                    <div>
                      <dt className="font-mono text-2xs uppercase text-muted-foreground">Stop</dt>
                      <dd className="mt-1 text-foreground">{loop.stop ?? "Not stated"}</dd>
                    </div>
                  </dl>
                </article>
              )
            })}
          </div>
        </section>
      ) : null}
    </div>
  )
}
