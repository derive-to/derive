import { useMemo, useState } from "react"
import type { ContextDetail } from "@/api"
import { Icon } from "@/components/icons"
import { EmptyState } from "@/components/shared/empty-state"
import { SectionEyebrow } from "@/components/shared/section-eyebrow"
import { cn } from "@/lib/utils"
import { linkedBundleEdgePath, linkedBundleLayout } from "../artifact/linked-bundle-workspace"

type Definition = NonNullable<ContextDetail["workflow_definition"]>
type Diagram = Definition["diagrams"][number]
type Node = Diagram["nodes"][number]
type Route = Diagram["routes"][number]
type Selection = { kind: "node"; id: string } | { kind: "route"; from: string; to: string }

const NODE_WIDTH = 184
const COMPACT_GRAPH_STEP = 240
const COMPACT_GRAPH_PAD = 24

const nodeLabel = (node: Node): string =>
  node.kind === "context"
    ? node.result || node.instruction || node.id
    : node.kind === "human"
      ? node.decision || node.id
      : node.result || node.id

const sentence = (value: string): string => (/[^\s][.!?]$/.test(value) ? value : `${value}.`)

export const contextWorkflowNodeNote = (node: Node): string => {
  if (node.kind === "context")
    return `Calls ${node.context_ref ?? "an unresolved context"}. ${node.instruction ?? "No instruction declared."}`
  if (node.kind === "human")
    return `${sentence(node.decision ?? "Human decision required")} Resume with ${sentence(node.resume ?? "the declared choice")}`
  return node.result ?? "Ends the run."
}

function KindPill({ kind }: { kind: Node["kind"] }) {
  return (
    <span className="rounded-md border bg-muted/35 px-1.5 py-0.5 font-mono text-2xs text-muted-foreground">
      {kind}
    </span>
  )
}

function NodeDetail({ node }: { node: Node }) {
  return (
    <div className="flex flex-col gap-4" data-testid="workflow-node-detail">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-heading text-base font-medium break-words">{node.id}</h3>
          <KindPill kind={node.kind} />
          {(node.kind === "terminal" || node.terminal) && (
            <span className="rounded-md border border-success/20 bg-success/10 px-1.5 py-0.5 font-mono text-2xs text-success">
              terminal
            </span>
          )}
        </div>
        <p className="mt-2 text-sm break-words text-muted-foreground">
          {contextWorkflowNodeNote(node)}
        </p>
      </div>

      {node.kind === "context" && (
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div className="min-w-0 rounded-lg border bg-muted/20 p-3">
            <dt className="font-mono text-2xs text-muted-foreground">Context</dt>
            <dd className="mt-1 break-words">{node.context_ref ?? "Not set"}</dd>
          </div>
          <div className="min-w-0 rounded-lg border bg-muted/20 p-3">
            <dt className="font-mono text-2xs text-muted-foreground">Expected result</dt>
            <dd className="mt-1 break-words">{node.result ?? "Not set"}</dd>
          </div>
          <div className="min-w-0 rounded-lg border bg-muted/20 p-3 sm:col-span-2">
            <dt className="font-mono text-2xs text-muted-foreground">Instruction</dt>
            <dd className="mt-1 whitespace-pre-wrap break-words">
              {node.instruction ?? "Not set"}
            </dd>
          </div>
        </dl>
      )}

      {node.kind === "human" && (
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div className="min-w-0 rounded-lg border bg-muted/20 p-3">
            <dt className="font-mono text-2xs text-muted-foreground">Decision</dt>
            <dd className="mt-1 break-words">{node.decision ?? "Not set"}</dd>
          </div>
          <div className="min-w-0 rounded-lg border bg-muted/20 p-3">
            <dt className="font-mono text-2xs text-muted-foreground">Resume</dt>
            <dd className="mt-1 break-words">{node.resume ?? "Not set"}</dd>
          </div>
          <div className="min-w-0 rounded-lg border bg-muted/20 p-3 sm:col-span-2">
            <dt className="font-mono text-2xs text-muted-foreground">Options</dt>
            <dd className="mt-2 flex flex-wrap gap-1.5">
              {(node.options ?? []).map((option) => (
                <span
                  key={option}
                  className="rounded-md border bg-card px-2 py-1 font-mono text-xs"
                >
                  {option}
                </span>
              ))}
            </dd>
          </div>
        </dl>
      )}

      {(node.effects?.length ?? 0) > 0 && (
        <div>
          <SectionEyebrow>Effects · {node.effects?.length}</SectionEyebrow>
          <ul className="mt-2 flex flex-col gap-2">
            {node.effects?.map((effect) => (
              <li
                key={`${effect.kind}:${effect.gate}:${effect.description}:${effect.idempotency ?? effect.approval_ref ?? ""}`}
                className="rounded-lg border bg-muted/20 p-3 text-sm"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-2xs uppercase text-muted-foreground">
                    {effect.kind}
                  </span>
                  <span
                    className={cn(
                      "rounded-md border px-1.5 py-0.5 font-mono text-2xs",
                      effect.gate === "human"
                        ? "border-warning/20 bg-warning/10 text-warning"
                        : "border-success/20 bg-success/10 text-success",
                    )}
                  >
                    {effect.gate === "human"
                      ? `human gate · ${effect.approval_ref}`
                      : "replay-safe"}
                  </span>
                </div>
                <p className="mt-1 break-words text-muted-foreground">{effect.description}</p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function RouteDetail({ route, diagram }: { route: Route; diagram: Diagram }) {
  const from = diagram.nodes.find((node) => node.id === route.from)
  const to = diagram.nodes.find((node) => node.id === route.to)
  return (
    <div className="flex flex-col gap-4" data-testid="workflow-route-detail">
      <div>
        <span className="font-mono text-2xs text-muted-foreground">Authoritative route</span>
        <h3 className="mt-1 font-heading text-base font-medium break-words">
          {from?.id ?? route.from} → {to?.id ?? route.to}
        </h3>
      </div>
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <div className="rounded-lg border bg-muted/20 p-3">
          <dt className="font-mono text-2xs text-muted-foreground">When</dt>
          <dd className="mt-1 break-words">{route.when}</dd>
        </div>
        <div className="rounded-lg border bg-muted/20 p-3">
          <dt className="font-mono text-2xs text-muted-foreground">Fallback</dt>
          <dd className="mt-1">{route.fallback ? "Yes" : "No"}</dd>
        </div>
      </dl>
      <p className="rounded-lg border border-share/20 bg-share/5 p-3 text-sm text-muted-foreground">
        The condition above controls execution. Any canvas label is presentation only.
      </p>
    </div>
  )
}

function DefinitionCanvas({
  context,
  diagram,
  selection,
  onSelect,
}: {
  context: ContextDetail
  diagram: Diagram
  selection: Selection | null
  onSelect: (selection: Selection) => void
}) {
  const visual = useMemo(
    () => ({
      id: diagram.id,
      title: context.name,
      type: context.kind === "loop" ? ("loop" as const) : ("graph" as const),
      nodes: diagram.nodes.map((node) => ({ id: node.id, label: nodeLabel(node) })),
      edges: diagram.routes.map((route) => ({
        from: route.from,
        to: route.to,
        label: route.when,
      })),
    }),
    [context.kind, context.name, diagram],
  )
  const layout = useMemo(() => {
    const laidOut = linkedBundleLayout(visual)
    if (visual.type !== "graph") return laidOut

    // The shared artifact canvas leaves generous editing space between columns.
    // This surface is an inspector inside a two-column console, so keep the same
    // topology while tightening columns enough to show a normal three-stage graph
    // without making the person discover horizontal scrolling first.
    const columns = [...new Set(Object.values(laidOut.nodes).map((point) => point.x))].sort(
      (a, b) => a - b,
    )
    const columnIndex = new Map(columns.map((x, index) => [x, index]))
    const width = Math.max(
      660,
      COMPACT_GRAPH_PAD * 2 + NODE_WIDTH + Math.max(0, columns.length - 1) * COMPACT_GRAPH_STEP,
    )
    return {
      ...laidOut,
      width,
      nodes: Object.fromEntries(
        Object.entries(laidOut.nodes).map(([id, point]) => [
          id,
          {
            ...point,
            x: COMPACT_GRAPH_PAD + (columnIndex.get(point.x) ?? 0) * COMPACT_GRAPH_STEP,
          },
        ]),
      ),
    }
  }, [visual])
  const marker = `context-definition-arrow-${diagram.id}`
  return (
    <div className="mt-5 overflow-x-auto rounded-xl border bg-muted/15 p-3 sm:p-4">
      <div
        className="relative mx-auto"
        style={{ width: layout.width, height: layout.height }}
        data-testid="workflow-definition-canvas"
      >
        <svg
          className="absolute inset-0 size-full overflow-visible text-border"
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          aria-hidden="true"
        >
          <defs>
            <marker id={marker} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
              <path d="M 0 0 L 8 4 L 0 8 z" fill="currentColor" />
            </marker>
          </defs>
          {visual.edges.map((edge, index) => {
            const path = linkedBundleEdgePath(visual, edge, layout.nodes)
            const route = diagram.routes[index]
            const active =
              route &&
              selection?.kind === "route" &&
              selection.from === route.from &&
              selection.to === route.to
            return (
              <path
                key={`${edge.from}:${edge.to}`}
                d={path.d}
                fill="none"
                stroke="currentColor"
                strokeWidth={active ? 3 : 1.5}
                markerEnd={`url(#${marker})`}
                className={active ? "text-share" : undefined}
              />
            )
          })}
        </svg>

        {diagram.routes.map((route, index) => {
          const edge = visual.edges[index]
          if (!edge) return null
          const path = linkedBundleEdgePath(visual, edge, layout.nodes)
          const active =
            selection?.kind === "route" &&
            selection.from === route.from &&
            selection.to === route.to
          return (
            <button
              key={`${route.from}:${route.to}`}
              type="button"
              data-testid="workflow-route"
              aria-pressed={active}
              aria-label={`${route.from} to ${route.to}: ${route.when}`}
              onClick={() => onSelect({ kind: "route", from: route.from, to: route.to })}
              style={{ left: path.x, top: path.y }}
              className={cn(
                "absolute z-10 -translate-x-1/2 -translate-y-1/2 rounded-full border bg-card px-2 py-1 font-mono text-2xs text-muted-foreground shadow-sm outline-none hover:border-share/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                active && "border-share/50 bg-share/10 text-share",
              )}
            >
              {route.when}
              {route.fallback ? " · fallback" : ""}
            </button>
          )
        })}

        {diagram.nodes.map((node) => {
          const point = layout.nodes[node.id] ?? { x: 0, y: 0 }
          const active = selection?.kind === "node" && selection.id === node.id
          return (
            <button
              key={node.id}
              type="button"
              data-testid="workflow-node"
              aria-pressed={active}
              onClick={() => onSelect({ kind: "node", id: node.id })}
              style={{ left: point.x, top: point.y, width: NODE_WIDTH, height: 112 }}
              className={cn(
                "absolute z-20 flex flex-col gap-2 rounded-xl border bg-card p-3 text-left shadow-sm outline-none transition-[border-color,box-shadow,transform] hover:-translate-y-0.5 hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring",
                active && "border-share/50 ring-2 ring-share/20",
              )}
            >
              <span className="flex min-w-0 items-center gap-2">
                <Icon
                  name={
                    node.kind === "human" ? "user" : node.kind === "terminal" ? "check" : "context"
                  }
                  className="shrink-0 text-muted-foreground"
                />
                <span className="truncate text-sm font-semibold">{node.id}</span>
              </span>
              <span className="line-clamp-3 text-xs text-muted-foreground">{nodeLabel(node)}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

export function ContextWorkflowDefinition({ context }: { context: ContextDetail }) {
  const definition = context.workflow_definition
  const diagram = definition?.diagrams[0]
  const [selection, setSelection] = useState<Selection | null>(() =>
    diagram?.nodes[0] ? { kind: "node", id: diagram.nodes[0].id } : null,
  )

  if (!diagram) {
    return (
      <div className="flex flex-col gap-3">
        <EmptyState
          icon={<Icon name={context.kind === "loop" ? "loop" : "graph"} />}
          title="Definition needs changes"
          description="This context stays visible, but it cannot run until its manifest validates."
        />
        {context.manifest_errors.length > 0 && (
          <ul className="rounded-xl border border-warning/20 bg-warning/5 p-4 text-sm text-warning">
            {context.manifest_errors.map((error) => (
              <li key={error} className="break-words">
                {error}
              </li>
            ))}
          </ul>
        )}
      </div>
    )
  }

  const selectedNode =
    selection?.kind === "node"
      ? (diagram.nodes.find((node) => node.id === selection.id) ?? null)
      : null
  const selectedRoute =
    selection?.kind === "route"
      ? (diagram.routes.find(
          (route) => route.from === selection.from && route.to === selection.to,
        ) ?? null)
      : null

  return (
    <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="min-w-0 rounded-xl border bg-card p-4">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0">
            <SectionEyebrow>
              {context.kind} · {diagram.id}
            </SectionEyebrow>
            <h2 className="mt-1 font-heading text-lg font-medium break-words">
              {definition.purpose}
            </h2>
          </div>
          <span className="ml-auto rounded-md border border-share/20 bg-share/10 px-2 py-1 font-mono text-2xs text-share">
            Ready to run
          </span>
        </div>

        <DefinitionCanvas
          context={context}
          diagram={diagram}
          selection={selection}
          onSelect={setSelection}
        />

        {(diagram.loops?.length ?? 0) > 0 && (
          <div className="mt-4 border-t pt-4">
            <SectionEyebrow>Bounds · {diagram.loops?.length}</SectionEyebrow>
            <ul className="mt-2 grid gap-2 sm:grid-cols-2">
              {diagram.loops?.map((loop) => (
                <li key={loop.id} className="rounded-lg border bg-muted/20 p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{loop.goal}</span>
                    <span className="rounded-md border bg-card px-1.5 py-0.5 font-mono text-2xs">
                      max {loop.stop.max_attempts}
                    </span>
                  </div>
                  <p className="mt-1 break-words text-muted-foreground">
                    Evaluate: {loop.evaluate}
                  </p>
                  <p className="mt-1 break-words text-xs text-muted-foreground">
                    Human stop: {loop.stop.human_stop}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <aside className="min-w-0 rounded-xl border bg-card p-4" aria-live="polite">
        <SectionEyebrow>What happens here</SectionEyebrow>
        <div className="mt-3">
          {selectedNode ? (
            <NodeDetail node={selectedNode} />
          ) : selectedRoute ? (
            <RouteDetail route={selectedRoute} diagram={diagram} />
          ) : (
            <p className="text-sm text-muted-foreground">Select a node or route to inspect it.</p>
          )}
        </div>
      </aside>
    </div>
  )
}
