import { useEffect, useMemo, useRef, useState } from "react"
import type { Artifact, Comment, DirUser } from "@/api"
import { Icon } from "@/components/icons"
import { Count } from "@/components/shared/section-eyebrow"
import { Button } from "@/components/ui/button"
import { ago } from "@/lib/time"
import { cn } from "@/lib/utils"
import { LinkedBundleFocusSearch, type LinkedBundleFocusTarget } from "./linked-bundle-focus"
import {
  type LinkedBundleWorkflowNode,
  linkedBundleNodeNote,
  linkedBundleWorkflowNodeMap,
} from "./linked-bundle-node-details"
import { LinkedBundleNodeDetailsPanel } from "./linked-bundle-node-details-panel"
import { LinkedBundleNodeNoteEditor } from "./linked-bundle-node-note-editor"
import { linkedBundleNodeStateDot as stateDot } from "./linked-bundle-node-state"
import {
  LinkedBundleNowWorkspace,
  linkedBundleCurrentNodes,
  linkedBundleHasRunState,
  linkedBundleInitialView,
} from "./linked-bundle-now-workspace"
import {
  linkedBundleCommentCounts,
  linkedBundleEffectiveTier,
  linkedBundleMemberDetail,
  linkedBundleReviewTarget,
} from "./linked-bundle-panel"
import type { Sel } from "./types"
import { WorkflowPreview } from "./workflow-preview"
import { WorkflowRunDialog } from "./workflow-run-dialog"

type LinkedBundle = NonNullable<Artifact["linked_bundle"]>
type Diagram = NonNullable<LinkedBundle["diagrams"]>[number]
type DiagramNode = Diagram["nodes"][number]
type DiagramEdge = Diagram["edges"][number]
type BundleMember = LinkedBundle["members"][number]
type ReviewKind = "node" | "edge" | "policy"
type LinkedBundleView = "preview" | "now" | "advanced"

type Point = { x: number; y: number }
export type LinkedBundleVisualLayout = {
  width: number
  height: number
  nodes: Record<string, Point>
}

/** Keep dense graphs pannable rather than shrinking their labels below a readable size
 * on narrow screens. The canvas still fits on desktop, where overview matters most. */
export const linkedBundleFitScale = (canvasWidth: number, layoutWidth: number): number => {
  if (!canvasWidth) return 1
  const minimum = canvasWidth < 640 ? 0.72 : 0.28
  return Math.min(1, Math.max(minimum, (canvasWidth - 40) / layoutWidth))
}

const NODE_W = 184
const NODE_H = 128
const PAD_X = 58
const PAD_Y = 48
const GRAPH_COLUMN_STEP = 268

const groupsAtDepth = (diagram: Diagram): Map<number, string[]> => {
  const incoming = new Map(diagram.nodes.map((node) => [node.id, 0]))
  const outgoing = new Map(diagram.nodes.map((node) => [node.id, [] as string[]]))
  for (const edge of diagram.edges) {
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1)
    outgoing.get(edge.from)?.push(edge.to)
  }
  const queue = diagram.nodes.filter((node) => incoming.get(node.id) === 0).map((node) => node.id)
  const depth = new Map(diagram.nodes.map((node) => [node.id, 0]))
  const visited = new Set<string>()
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]
    if (!id) continue
    visited.add(id)
    for (const to of outgoing.get(id) ?? []) {
      depth.set(to, Math.max(depth.get(to) ?? 0, (depth.get(id) ?? 0) + 1))
      incoming.set(to, (incoming.get(to) ?? 1) - 1)
      if (incoming.get(to) === 0) queue.push(to)
    }
  }
  // Graphs may intentionally contain a cycle. Keep it visible without pretending
  // we found a topological order: preserve authored order across trailing columns
  // instead of stacking every unresolved node and edge on top of each other.
  const last = Math.max(0, ...depth.values()) + (visited.size ? 1 : 0)
  const unresolved = diagram.nodes.filter((node) => !visited.has(node.id))
  for (const [index, node] of unresolved.entries()) depth.set(node.id, last + index)
  const groups = new Map<number, string[]>()
  for (const node of diagram.nodes) {
    const d = depth.get(node.id) ?? 0
    groups.set(d, [...(groups.get(d) ?? []), node.id])
  }
  return groups
}

/** Deterministic, dependency-free first-pass layout. Loops use a cycle; graphs use
 * topology-derived columns. It is intentionally not a general canvas engine. */
export const linkedBundleLayout = (diagram: Diagram): LinkedBundleVisualLayout => {
  if (diagram.type === "loop") {
    const count = diagram.nodes.length
    const width = Math.max(620, count * 138)
    const height = Math.max(430, Math.ceil(count / 2) * 154)
    const cx = width / 2
    const cy = height / 2
    const rx = Math.max(155, width / 2 - NODE_W / 2 - PAD_X)
    const ry = Math.max(112, height / 2 - NODE_H / 2 - PAD_Y)
    const nodes: Record<string, Point> = {}
    diagram.nodes.forEach((node, index) => {
      const angle = -Math.PI / 2 + (index * Math.PI * 2) / Math.max(1, count)
      nodes[node.id] = {
        x: cx + Math.cos(angle) * rx - NODE_W / 2,
        y: cy + Math.sin(angle) * ry - NODE_H / 2,
      }
    })
    return { width, height, nodes }
  }

  const groups = groupsAtDepth(diagram)
  const columns = [...groups.entries()].sort(([a], [b]) => a - b)
  const maxRows = Math.max(1, ...columns.map(([, ids]) => ids.length))
  const width = Math.max(660, columns.length * GRAPH_COLUMN_STEP + PAD_X * 2)
  const height = Math.max(360, maxRows * 158 + PAD_Y * 2)
  const nodes: Record<string, Point> = {}
  columns.forEach(([, ids], column) => {
    const x = PAD_X + column * GRAPH_COLUMN_STEP
    const span = ids.length * NODE_H + Math.max(0, ids.length - 1) * 46
    const y0 = Math.max(PAD_Y, (height - span) / 2)
    ids.forEach((id, row) => {
      nodes[id] = { x, y: y0 + row * (NODE_H + 46) }
    })
  })
  return { width, height, nodes }
}

const semanticKind = (diagram: Diagram, kind: ReviewKind): string => {
  if (kind === "policy") return "loop-policy"
  if (kind === "node") return diagram.type === "loop" ? "loop-step" : "graph-node"
  return diagram.type === "loop" ? "loop-transition" : "graph-edge"
}

export const linkedBundleAnchor = (target: { id: string; kind: string; label: string }): Sel => ({
  type: "ElementSelector",
  tag: "div",
  role: target.kind,
  id: target.id,
  fingerprint: `linked-bundle:${target.id}`,
  ordinal: 0,
  docFraction: 0.5,
  snapshot: { tag: "div", label: target.label },
})

const stateTone = (state?: DiagramNode["state"]): string => {
  if (state === "done") return "border-success/40 bg-success/5"
  if (state === "active") return "border-insights/50 bg-insights/5"
  if (state === "waiting") return "border-warning/50 bg-warning/5"
  if (state === "blocked") return "border-destructive/50 bg-destructive/5"
  return "border-border bg-card"
}

const stateTextTone = (state?: DiagramNode["state"]): string => {
  if (state === "done") return "text-success"
  if (state === "active") return "text-insights"
  if (state === "waiting") return "text-warning"
  if (state === "blocked") return "text-destructive"
  return "text-muted-foreground"
}

export const linkedBundleNodeFreshness = (
  node: DiagramNode,
  member?: BundleMember,
): "fresh" | "updated" | null => {
  if (!node.basis_version || !member?.current_version) return null
  return member.current_version > node.basis_version ? "updated" : "fresh"
}

export const linkedBundleEdgePath = (
  diagram: Diagram,
  edge: DiagramEdge,
  points: Record<string, Point>,
): { d: string; x: number; y: number } => {
  const from = points[edge.from] ?? { x: 0, y: 0 }
  const to = points[edge.to] ?? { x: 0, y: 0 }
  const fx = from.x + NODE_W / 2
  const fy = from.y + NODE_H / 2
  const tx = to.x + NODE_W / 2
  const ty = to.y + NODE_H / 2
  if (edge.from === edge.to)
    return {
      d: `M ${fx + NODE_W / 3} ${fy} C ${fx + NODE_W} ${fy - 94}, ${fx - NODE_W} ${fy - 94}, ${fx - NODE_W / 3} ${fy}`,
      x: fx,
      y: fy - 84,
    }
  if (diagram.type === "graph") {
    const reciprocal = diagram.edges.some(
      (candidate) => candidate.from === edge.to && candidate.to === edge.from,
    )
    if (reciprocal) {
      const vx = tx - fx
      const vy = ty - fy
      const length = Math.max(1, Math.hypot(vx, vy))
      const nx = -vy / length
      const ny = vx / length
      const bend = 104
      const c1x = fx + vx / 3 + nx * bend
      const c1y = fy + vy / 3 + ny * bend
      const c2x = fx + (vx * 2) / 3 + nx * bend
      const c2y = fy + (vy * 2) / 3 + ny * bend
      return {
        d: `M ${fx} ${fy} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${tx} ${ty}`,
        x: (fx + tx) / 2 + nx * bend * 0.75,
        y: (fy + ty) / 2 + ny * bend * 0.75,
      }
    }
    const dx = Math.max(58, Math.abs(tx - fx) / 2)
    return {
      d: `M ${fx} ${fy} C ${fx + dx} ${fy}, ${tx - dx} ${ty}, ${tx} ${ty}`,
      x: (fx + tx) / 2,
      y: (fy + ty) / 2,
    }
  }
  return { d: `M ${fx} ${fy} L ${tx} ${ty}`, x: (fx + tx) / 2, y: (fy + ty) / 2 }
}

export type LinkedBundleSelected = { diagram: string; kind: ReviewKind; local: string }
export type LinkedBundleReviewState = {
  selected: LinkedBundleSelected | null
  focus: boolean
  fit: boolean
  inspector: boolean
}

export const emptyLinkedBundleReviewState = (): LinkedBundleReviewState => ({
  selected: null,
  focus: false,
  fit: true,
  inspector: false,
})

export const linkedBundleFocusedElements = (
  diagram: Diagram,
  selected: LinkedBundleSelected | null,
): { nodes: Set<string>; edges: Set<number> } => {
  const nodes = new Set<string>()
  const edges = new Set<number>()
  if (!selected || selected.diagram !== diagram.id || selected.kind === "policy")
    return { nodes, edges }
  if (selected.kind === "edge") {
    const index = Number(selected.local.split("-")[0])
    const edge = diagram.edges[index]
    if (edge) {
      edges.add(index)
      nodes.add(edge.from)
      nodes.add(edge.to)
    }
    return { nodes, edges }
  }
  nodes.add(selected.local)
  diagram.edges.forEach((edge, index) => {
    if (edge.from === selected.local || edge.to === selected.local) {
      edges.add(index)
      nodes.add(edge.from)
      nodes.add(edge.to)
    }
  })
  return { nodes, edges }
}

function DiagramWorkspace({
  diagram,
  members,
  workflowNodes,
  counts,
  reviewState,
  pinning,
  canComment,
  onReviewStateChange,
  onPin,
  onReview,
  shortId,
  version,
  canEdit,
  onSaved,
}: {
  diagram: Diagram
  members: Map<string, BundleMember>
  workflowNodes: Map<string, LinkedBundleWorkflowNode>
  counts: Map<string, number>
  reviewState: LinkedBundleReviewState
  pinning: boolean
  canComment: boolean
  onReviewStateChange: (state: LinkedBundleReviewState) => void
  onPin: (target: { id: string; kind: string; label: string }) => void
  onReview: (target: string) => void
  shortId: string
  version: number
  canEdit: boolean
  onSaved: () => void
}) {
  const layout = useMemo(() => linkedBundleLayout(diagram), [diagram])
  const canvasRef = useRef<HTMLDivElement>(null)
  const [canvasWidth, setCanvasWidth] = useState(0)
  const { selected, fit, focus: focusActive, inspector: editingNote } = reviewState
  const marker = `bundle-arrow-${diagram.id}`
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const measure = () => setCanvasWidth(canvas.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (!focusActive || selected?.diagram !== diagram.id || selected.kind !== "node") return
    const frame = requestAnimationFrame(() => {
      const target = canvasRef.current?.querySelector<HTMLElement>(
        `[data-bundle-local="${CSS.escape(selected.local)}"]`,
      )
      target?.scrollIntoView({ block: "nearest", inline: "center" })
    })
    return () => cancelAnimationFrame(frame)
  }, [diagram.id, focusActive, selected])
  useEffect(() => {
    if (!editingNote) return
    const frame = requestAnimationFrame(() => {
      canvasRef.current
        ?.closest("section")
        ?.querySelector<HTMLElement>("[data-testid=bundle-note-editor]")
        ?.scrollIntoView({ block: "center", behavior: "smooth" })
    })
    return () => cancelAnimationFrame(frame)
  }, [editingNote])
  const scale = fit ? linkedBundleFitScale(canvasWidth, layout.width) : 1
  const select = (kind: ReviewKind, local: string, label: string) => {
    const id = linkedBundleReviewTarget(diagram.id, kind, local)
    if (pinning && canComment) {
      onPin({ id, kind: semanticKind(diagram, kind), label })
      return
    }
    onReviewStateChange({
      ...reviewState,
      selected: { diagram: diagram.id, kind, local },
      focus: kind !== "policy",
      inspector: false,
    })
  }
  const focused = useMemo(
    () => linkedBundleFocusedElements(diagram, focusActive ? selected : null),
    [diagram, focusActive, selected],
  )
  const currentNodes = useMemo(() => linkedBundleCurrentNodes(diagram), [diagram])

  const selection = (() => {
    if (!selected || selected.diagram !== diagram.id) return null
    if (selected.kind === "node") {
      const node = diagram.nodes.find((item) => item.id === selected.local)
      if (!node) return null
      const member = node.member ? members.get(node.member) : undefined
      const note = linkedBundleNodeNote(node, workflowNodes.get(`${diagram.id}:${node.id}`))
      return {
        target: linkedBundleReviewTarget(diagram.id, "node", node.id),
        title: node.label,
        eyebrow: diagram.type === "loop" ? "Loop step" : "Graph node",
        detail: note.text,
        note,
        count: counts.get(linkedBundleReviewTarget(diagram.id, "node", node.id)) ?? 0,
        state: node.state,
        tier: linkedBundleEffectiveTier(node, diagram),
        freshness: linkedBundleNodeFreshness(node, member),
        basis: node.basis_version,
        member,
        node,
      }
    }
    if (selected.kind === "edge") {
      const index = Number(selected.local.split("-")[0])
      const edge = diagram.edges[index]
      if (!edge) return null
      const target = linkedBundleReviewTarget(diagram.id, "edge", selected.local)
      return {
        target,
        title: `${edge.from} → ${edge.to}`,
        eyebrow: diagram.type === "loop" ? "Loop transition" : "Graph relationship",
        detail: edge.label ?? "Unlabelled relationship",
        count: counts.get(target) ?? 0,
      }
    }
    const value = diagram[selected.local as "goal" | "evaluate" | "stop"]
    const target = linkedBundleReviewTarget(diagram.id, "policy", selected.local)
    return {
      target,
      title: selected.local[0]?.toUpperCase() + selected.local.slice(1),
      eyebrow: "Loop policy",
      detail: value ?? "Not stated",
      count: counts.get(target) ?? 0,
    }
  })()

  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border-soft px-4 py-3.5">
        <div>
          <div className="font-mono text-2xs uppercase tracking-[0.12em] text-muted-foreground">
            {diagram.type} · {diagram.nodes.length} {diagram.type === "loop" ? "steps" : "nodes"}
          </div>
          <h3 className="mt-1 text-base font-semibold text-foreground">{diagram.title}</h3>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">
            {diagram.edges.length} {diagram.type === "loop" ? "transitions" : "relationships"}
          </span>
          <div className="flex rounded-lg border border-border p-0.5">
            <button
              type="button"
              data-testid={`bundle-fit-${diagram.id}`}
              onClick={() => {
                onReviewStateChange({ ...reviewState, fit: true, focus: false })
              }}
              className={cn(
                "rounded-md px-2 py-1 font-mono text-2xs text-muted-foreground",
                fit && "bg-muted text-foreground",
              )}
            >
              Fit
            </button>
            <button
              type="button"
              data-testid={`bundle-actual-size-${diagram.id}`}
              onClick={() => onReviewStateChange({ ...reviewState, fit: false })}
              className={cn(
                "rounded-md px-2 py-1 font-mono text-2xs text-muted-foreground",
                !fit && "bg-muted text-foreground",
              )}
            >
              100%
            </button>
          </div>
          {focusActive && selection ? (
            <Button
              variant="outline"
              size="sm"
              data-testid={`bundle-back-to-fit-${diagram.id}`}
              onClick={() => {
                onReviewStateChange({ ...reviewState, fit: true, focus: false })
              }}
            >
              Back to Fit
            </Button>
          ) : null}
        </div>
      </div>

      {focusActive && selection ? (
        <div className="flex items-center gap-2 border-b border-border-soft bg-primary/5 px-4 py-2 text-xs">
          <span className="font-medium text-primary">Reviewing {selection.title}</span>
          <span className="text-muted-foreground">Immediate context stays visible.</span>
        </div>
      ) : null}

      {diagram.type === "loop" ? (
        <div className="grid border-b border-border-soft sm:grid-cols-3">
          {(["goal", "evaluate", "stop"] as const).map((key) => {
            const target = linkedBundleReviewTarget(diagram.id, "policy", key)
            const active =
              selected?.diagram === diagram.id &&
              selected.kind === "policy" &&
              selected.local === key
            return (
              <button
                key={key}
                type="button"
                data-testid={`bundle-policy-${diagram.id}-${key}`}
                onClick={() =>
                  select("policy", key, `Loop ${key} — ${diagram[key] ?? "Not stated"}`)
                }
                className={cn(
                  "border-t border-border-soft px-4 py-3 text-left first:border-t-0 hover:bg-muted/40 sm:border-t-0 sm:border-l sm:first:border-l-0",
                  active && "bg-primary/5",
                )}
              >
                <span className="font-mono text-2xs uppercase tracking-[0.1em] text-muted-foreground">
                  {key}
                </span>
                <span className="mt-1 block line-clamp-2 text-xs text-foreground">
                  {diagram[key] ?? "Not stated"}
                </span>
                {(counts.get(target) ?? 0) > 0 ? <Count>{counts.get(target)}</Count> : null}
              </button>
            )
          })}
        </div>
      ) : null}

      {currentNodes.length ? (
        <div className="flex items-center gap-2 overflow-x-auto border-b border-border-soft bg-muted/15 px-3 py-2 sm:hidden">
          <span className="shrink-0 font-mono text-2xs uppercase tracking-[0.1em] text-muted-foreground">
            Current
          </span>
          {currentNodes.map((node) => (
            <button
              key={node.id}
              type="button"
              data-testid={`bundle-current-${diagram.id}-${node.id}`}
              onClick={() =>
                select(
                  "node",
                  node.id,
                  `${diagram.type === "loop" ? "Loop step" : "Graph node"} — ${node.label}`,
                )
              }
              className="shrink-0 rounded-full border border-border bg-card px-2.5 py-1 text-xs font-medium text-foreground"
            >
              {node.label}
              {node.help?.needed ? (
                <span className="ml-1 text-destructive">· needs help</span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}

      <div className="min-h-0">
        <div ref={canvasRef} className="min-h-0 overflow-auto bg-muted/15 p-3 sm:p-5">
          <div
            className="relative mx-auto"
            style={{ width: layout.width * scale, height: layout.height * scale }}
            data-testid={`bundle-canvas-${diagram.id}`}
          >
            {!focusActive ? (
              <div className="pointer-events-none absolute left-3 top-3 z-30 rounded-full border border-border bg-card/95 px-2.5 py-1 font-mono text-2xs text-muted-foreground shadow-sm sm:hidden">
                Choose current work or drag to explore
              </div>
            ) : null}
            <div
              className="absolute left-0 top-0"
              style={{
                width: layout.width,
                height: layout.height,
                transform: `scale(${scale})`,
                transformOrigin: "top left",
              }}
            >
              <svg
                className="absolute inset-0 size-full overflow-visible text-border"
                viewBox={`0 0 ${layout.width} ${layout.height}`}
                aria-hidden="true"
              >
                <defs>
                  <marker
                    id={marker}
                    markerWidth="8"
                    markerHeight="8"
                    refX="7"
                    refY="4"
                    orient="auto"
                  >
                    <path d="M 0 0 L 8 4 L 0 8 z" fill="currentColor" />
                  </marker>
                </defs>
                {diagram.edges.map((edge, index) => {
                  const local = `${index}-${edge.from}-${edge.to}`
                  const target = linkedBundleReviewTarget(diagram.id, "edge", local)
                  const path = linkedBundleEdgePath(diagram, edge, layout.nodes)
                  const active =
                    selected?.diagram === diagram.id &&
                    selected.kind === "edge" &&
                    selected.local === local
                  const inFocus = !focusActive || focused.edges.has(index)
                  return (
                    <path
                      key={target}
                      d={path.d}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={active ? 4 : inFocus && focusActive ? 2.5 : 1.5}
                      markerEnd={`url(#${marker})`}
                      className={cn(
                        "transition-[color,opacity]",
                        active && "text-primary",
                        focusActive && !inFocus && "opacity-15",
                        focusActive && inFocus && !active && "text-foreground/55",
                      )}
                    />
                  )
                })}
              </svg>

              {diagram.edges.map((edge, index) => {
                const local = `${index}-${edge.from}-${edge.to}`
                const target = linkedBundleReviewTarget(diagram.id, "edge", local)
                const path = linkedBundleEdgePath(diagram, edge, layout.nodes)
                const active =
                  selected?.diagram === diagram.id &&
                  selected.kind === "edge" &&
                  selected.local === local
                const inFocus = !focusActive || focused.edges.has(index)
                return (
                  <button
                    key={target}
                    type="button"
                    data-testid={`bundle-edge-${diagram.id}-${index}`}
                    onClick={() =>
                      select(
                        "edge",
                        local,
                        `${diagram.type === "loop" ? "Loop transition" : "Graph edge"} — ${edge.from} → ${edge.to}${edge.label ? ` · ${edge.label}` : ""}`,
                      )
                    }
                    className={cn(
                      "absolute z-10 flex -translate-x-1/2 -translate-y-1/2 items-center gap-1 rounded-full border border-border bg-card px-2 py-1 font-mono text-2xs text-muted-foreground shadow-sm transition-[border-color,color,background-color,opacity,transform] hover:border-primary/40 hover:text-foreground",
                      active && "scale-110 border-primary bg-primary/10 text-primary shadow-md",
                      focusActive && !inFocus && "opacity-20",
                      pinning && canComment && "cursor-crosshair",
                    )}
                    style={{ left: path.x, top: path.y }}
                    aria-label={`${edge.from} to ${edge.to}${edge.label ? `: ${edge.label}` : ""}`}
                  >
                    <span>{edge.label ?? "→"}</span>
                    {(counts.get(target) ?? 0) > 0 ? <Count>{counts.get(target)}</Count> : null}
                  </button>
                )
              })}

              {diagram.nodes.map((node) => {
                const point = layout.nodes[node.id] ?? { x: 0, y: 0 }
                const member = node.member ? members.get(node.member) : undefined
                const target = linkedBundleReviewTarget(diagram.id, "node", node.id)
                const active =
                  selected?.diagram === diagram.id &&
                  selected.kind === "node" &&
                  selected.local === node.id
                const inFocus = !focusActive || focused.nodes.has(node.id)
                const freshness = linkedBundleNodeFreshness(node, member)
                const tier = linkedBundleEffectiveTier(node, diagram)
                return (
                  <button
                    key={node.id}
                    type="button"
                    data-testid={`bundle-node-${diagram.id}-${node.id}`}
                    data-bundle-local={node.id}
                    onClick={() =>
                      select(
                        "node",
                        node.id,
                        `${diagram.type === "loop" ? "Loop step" : "Graph node"} — ${node.label}`,
                      )
                    }
                    className={cn(
                      "absolute z-20 flex cursor-pointer flex-col rounded-xl border p-3 text-left shadow-sm transition-[border-color,box-shadow,transform,opacity] hover:-translate-y-0.5 hover:border-primary/45 hover:shadow-md focus-visible:ring-[3px] focus-visible:ring-primary/45",
                      stateTone(node.state),
                      active && "-translate-y-1 ring-[3px] ring-primary/55 shadow-lg",
                      focusActive && !inFocus && "opacity-25",
                      pinning && canComment && "cursor-crosshair",
                    )}
                    style={{ left: point.x, top: point.y, width: NODE_W, height: NODE_H }}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span className={cn("size-2 shrink-0 rounded-full", stateDot(node.state))} />
                      <span className="truncate text-sm font-semibold text-foreground">
                        {node.label}
                      </span>
                      {node.help?.needed ? (
                        <span className="ml-auto shrink-0 rounded border border-destructive/40 bg-destructive/10 px-1.5 py-0.5 font-mono text-2xs font-semibold uppercase tracking-[0.08em] text-destructive">
                          Needs help
                        </span>
                      ) : null}
                    </span>
                    {node.state || tier || node.role || node.confidence ? (
                      <span className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-2xs text-muted-foreground">
                        {node.state ? (
                          <span className={cn("capitalize", stateTextTone(node.state))}>
                            {node.state}
                          </span>
                        ) : null}
                        {tier ? <span>tier {tier}</span> : null}
                        {node.role ? <span className="truncate">{node.role}</span> : null}
                        {node.confidence ? (
                          <span className="capitalize">{node.confidence.level} confidence</span>
                        ) : null}
                      </span>
                    ) : null}
                    {member || (counts.get(target) ?? 0) > 0 ? (
                      <span className="mt-1 flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground">
                        {member ? <span className="truncate">{member.label}</span> : null}
                        {(counts.get(target) ?? 0) > 0 ? <Count>{counts.get(target)}</Count> : null}
                      </span>
                    ) : null}
                    {freshness === "updated" ? (
                      <span className="font-mono text-2xs text-warning">artifact updated</span>
                    ) : null}
                    <span className="mt-auto flex w-full items-center justify-end gap-1 font-mono text-2xs font-medium text-primary">
                      Details <Icon name="arrow" size={11} />
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        </div>

        <aside className="border-t border-border-soft bg-card p-4 pb-14 lg:pb-4">
          {selection ? (
            <div data-testid="bundle-selection" className="grid items-start gap-4">
              <div className="min-w-0">
                <div className="font-mono text-2xs uppercase tracking-[0.12em] text-muted-foreground">
                  {selection.eyebrow}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                  <h4 className="text-base font-semibold text-foreground">{selection.title}</h4>
                  {selection.state ? (
                    <span className="flex items-center gap-1.5 text-xs">
                      <span className={cn("size-2 rounded-full", stateDot(selection.state))} />
                      <span className={cn("capitalize", stateTextTone(selection.state))}>
                        {selection.state}
                      </span>
                      {selection.basis ? (
                        <span className="text-muted-foreground">· based on v{selection.basis}</span>
                      ) : null}
                    </span>
                  ) : null}
                  {"tier" in selection && selection.tier ? (
                    <span className="text-xs text-muted-foreground">Tier {selection.tier}</span>
                  ) : null}
                </div>
                {selection.node && canEdit && editingNote ? (
                  <LinkedBundleNodeNoteEditor
                    key={`${diagram.id}:${selection.node.id}`}
                    shortId={shortId}
                    version={version}
                    diagramId={diagram.id}
                    node={selection.node}
                    workflowDraft={
                      selection.note.source === "workflow" ? selection.note.text : null
                    }
                    onClose={() => onReviewStateChange({ ...reviewState, inspector: false })}
                    onSaved={onSaved}
                  />
                ) : selection.node ? (
                  <LinkedBundleNodeDetailsPanel
                    note={selection.note}
                    onEdit={
                      canEdit
                        ? () => onReviewStateChange({ ...reviewState, inspector: true })
                        : undefined
                    }
                  />
                ) : (
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    {selection.detail}
                  </p>
                )}
                {selection.freshness === "updated" && selection.member?.current_version ? (
                  <div className="mt-2 inline-flex rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-warning">
                    {selection.member.label} is now v{selection.member.current_version}. Reconcile
                    this authored state.
                  </div>
                ) : null}
              </div>
              <div className="flex flex-wrap gap-2">
                {selection.member?.available ? (
                  <Button
                    asChild
                    variant="outline"
                    size="sm"
                    className="justify-start"
                    data-testid="bundle-selection-open-member"
                  >
                    <a href={`/artifacts/${selection.member.ref}`}>
                      <Icon name="link" size={14} /> Open {selection.member.label}
                    </a>
                  </Button>
                ) : null}
                {canComment ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="justify-start"
                    data-testid="bundle-selection-comment"
                    onClick={() =>
                      onPin({
                        id: selection.target,
                        kind: semanticKind(diagram, selected?.kind ?? "node"),
                        label: `${selection.eyebrow} — ${selection.title}`,
                      })
                    }
                  >
                    <Icon name="pin" size={14} /> Comment here
                  </Button>
                ) : null}
                {selection.count > 0 ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="justify-start"
                    data-testid="bundle-selection-review"
                    onClick={() => onReview(selection.target)}
                  >
                    <Icon name="comments" size={14} /> Review {selection.count} open
                  </Button>
                ) : null}
              </div>
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">Select a policy, node, or edge.</div>
          )}
        </aside>
      </div>
    </section>
  )
}

function ArtifactShelf({
  members,
  afterMain = false,
}: {
  members: BundleMember[]
  afterMain?: boolean
}) {
  return (
    <aside
      className={cn(
        "min-w-0 lg:order-none lg:sticky lg:top-32 lg:max-h-[calc(100vh-9rem)] lg:self-start lg:overflow-y-auto",
        !afterMain && "order-first",
      )}
      data-testid="bundle-artifact-shelf"
    >
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Living artifacts</h2>
          <p className="mt-0.5 text-2xs text-muted-foreground">Always in this workspace</p>
        </div>
        <span className="shrink-0 font-mono text-2xs text-muted-foreground">
          {members.length} total
        </span>
      </div>
      <div className="flex gap-2 overflow-x-auto pb-2 lg:grid lg:overflow-visible lg:pb-0">
        {members.map((member) => (
          <a
            key={member.id}
            href={member.available ? `/artifacts/${member.ref}` : undefined}
            aria-disabled={!member.available}
            className={cn(
              "relative min-w-60 overflow-hidden rounded-xl border border-border bg-card p-3 pl-4 transition-colors lg:min-w-0",
              member.available ? "hover:border-primary/35 hover:bg-muted/30" : "opacity-60",
            )}
            data-testid={`bundle-workspace-member-${member.id}`}
          >
            <span
              aria-hidden="true"
              className={cn(
                "absolute inset-y-0 left-0 w-1",
                member.available ? "bg-success" : "bg-muted-foreground/35",
              )}
            />
            <span className="flex items-start justify-between gap-3">
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-foreground">
                  {member.label}
                </span>
                <span className="mt-1 block truncate text-2xs text-muted-foreground">
                  {linkedBundleMemberDetail(member)}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-1.5">
                {member.current_version ? (
                  <span className="rounded-md border border-share/20 bg-share/10 px-1.5 py-0.5 font-mono text-2xs font-semibold text-share">
                    v{member.current_version}
                  </span>
                ) : null}
                {member.available ? (
                  <Icon name="link" size={13} className="text-muted-foreground" />
                ) : null}
              </span>
            </span>
            <span className="mt-3 flex flex-wrap items-center gap-1.5 font-mono text-2xs">
              <span
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5",
                  member.updated_at
                    ? "border-success/20 bg-success/10 text-success"
                    : "border-border bg-muted/45 text-muted-foreground",
                )}
              >
                <span
                  className={cn(
                    "size-1.5 rounded-full",
                    member.updated_at ? "bg-success" : "bg-muted-foreground/50",
                  )}
                />
                {member.updated_at ? `Updated ${ago(member.updated_at)}` : "Not resolved"}
              </span>
              {(member.open_comment_count ?? 0) > 0 ? (
                <span className="rounded-md border border-warning/20 bg-warning/10 px-1.5 py-0.5 font-semibold text-warning">
                  {member.open_comment_count} open
                </span>
              ) : null}
            </span>
          </a>
        ))}
      </div>
    </aside>
  )
}

export function LinkedBundleWorkspace({
  shortId,
  version,
  bundle,
  workflowPreview,
  agents,
  comments,
  canComment,
  canEdit,
  pinning,
  refreshing,
  refreshedAt,
  onTogglePinning,
  onComment,
  onPin,
  onReview,
  onDocument,
  onEdit,
  onSaved,
  reviewState,
  onReviewStateChange,
}: {
  shortId: string
  version: number
  bundle: LinkedBundle
  workflowPreview?: Artifact["workflow_preview"]
  agents: DirUser[]
  comments: Comment[]
  canComment: boolean
  canEdit: boolean
  pinning: boolean
  refreshing: boolean
  refreshedAt: number
  onTogglePinning: () => void
  onComment: () => void
  onPin: (target: { id: string; kind: string; label: string }) => void
  onReview: (target: string) => void
  onDocument: () => void
  onEdit: () => void
  onSaved: () => void
  reviewState: LinkedBundleReviewState
  onReviewStateChange: (state: LinkedBundleReviewState) => void
}) {
  const diagrams = bundle.diagrams ?? []
  const counts = linkedBundleCommentCounts(comments)
  const members = useMemo(
    () => new Map(bundle.members.map((member) => [member.id, member])),
    [bundle.members],
  )
  const workflowNodes = useMemo(
    () => linkedBundleWorkflowNodeMap(workflowPreview),
    [workflowPreview],
  )
  const hasRunState = linkedBundleHasRunState(diagrams)
  const [view, setView] = useState<LinkedBundleView>(() =>
    linkedBundleInitialView(diagrams, !!workflowPreview),
  )
  const [runDiagram, setRunDiagram] = useState<string | null>(null)
  const selected = reviewState.selected
  useEffect(() => {
    if (hasRunState) setView("now")
  }, [hasRunState])
  useEffect(() => {
    if (!selected) {
      const first = diagrams[0]?.nodes[0]
      if (diagrams[0] && first)
        onReviewStateChange({
          ...reviewState,
          selected: { diagram: diagrams[0].id, kind: "node", local: first.id },
        })
      return
    }
    const diagram = diagrams.find((item) => item.id === selected.diagram)
    const exists =
      diagram &&
      (selected.kind === "node"
        ? diagram.nodes.some((node) => node.id === selected.local)
        : selected.kind === "edge"
          ? !!diagram.edges[Number(selected.local.split("-")[0])]
          : selected.local === "goal" || selected.local === "evaluate" || selected.local === "stop")
    if (!exists)
      onReviewStateChange({
        ...reviewState,
        selected: diagrams[0]?.nodes[0]
          ? { diagram: diagrams[0].id, kind: "node", local: diagrams[0].nodes[0].id }
          : null,
        focus: false,
        inspector: false,
      })
  }, [diagrams, onReviewStateChange, reviewState, selected])

  const focusNode = (target: { diagram: string; local: string }) => {
    setView("advanced")
    onReviewStateChange({
      selected: { diagram: target.diagram, kind: "node", local: target.local },
      focus: true,
      fit: false,
      inspector: false,
    })
  }
  const focusTarget = (target: LinkedBundleFocusTarget) => focusNode(target)

  const loops = diagrams.filter((diagram) => diagram.type === "loop").length
  const graphs = diagrams.length - loops
  return (
    <div
      className="min-h-0 flex-1 overflow-auto bg-background"
      data-testid="linked-bundle-workspace"
    >
      <div className="sticky top-0 z-30 border-b border-border bg-background/95 px-4 py-3 backdrop-blur sm:px-6">
        <div className="mx-auto grid max-w-[90rem] gap-3">
          <div className="min-w-0">
            <div className="font-mono text-2xs uppercase tracking-[0.12em] text-primary">
              Linked bundle workspace
            </div>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{bundle.purpose}</p>
            <div className="mt-2 font-mono text-2xs text-muted-foreground">
              {bundle.members.length} artifacts · {loops} loop{loops === 1 ? "" : "s"} · {graphs}{" "}
              graph{graphs === 1 ? "" : "s"} ·{" "}
              {refreshing
                ? "checking updates…"
                : `checked ${ago(new Date(refreshedAt).toISOString())}`}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <fieldset className="flex rounded-lg border border-border p-0.5">
              <legend className="sr-only">Workspace view</legend>
              {workflowPreview ? (
                <button
                  type="button"
                  data-testid="bundle-view-preview"
                  aria-pressed={view === "preview"}
                  onClick={() => setView("preview")}
                  className={cn(
                    "rounded-md px-2.5 py-1.5 text-xs text-muted-foreground",
                    view === "preview" && "bg-muted font-medium text-foreground",
                  )}
                >
                  Preview
                </button>
              ) : null}
              <button
                type="button"
                data-testid="bundle-view-now"
                aria-pressed={view === "now"}
                onClick={() => setView("now")}
                className={cn(
                  "rounded-md px-2.5 py-1.5 text-xs text-muted-foreground",
                  view === "now" && "bg-muted font-medium text-foreground",
                )}
              >
                Now
              </button>
              <button
                type="button"
                data-testid="bundle-view-advanced"
                aria-pressed={view === "advanced"}
                onClick={() => setView("advanced")}
                className={cn(
                  "rounded-md px-2.5 py-1.5 text-xs text-muted-foreground",
                  view === "advanced" && "bg-muted font-medium text-foreground",
                )}
              >
                Advanced
              </button>
            </fieldset>
            <LinkedBundleFocusSearch diagrams={diagrams} members={members} onFocus={focusTarget} />
            {canComment ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="bundle-workspace-comment"
                  onClick={onComment}
                >
                  <Icon name="comments" size={14} /> Comment
                </Button>
                <Button
                  variant={pinning ? "default" : "outline"}
                  size="sm"
                  data-testid="bundle-workspace-pin"
                  aria-pressed={pinning}
                  onClick={onTogglePinning}
                >
                  <Icon name="pin" size={14} weight={pinning ? "fill" : "regular"} />
                  {pinning ? "Cancel pin" : "Pin comment"}
                </Button>
              </>
            ) : null}
            {canEdit ? (
              <Button variant="outline" size="sm" onClick={onEdit} data-testid="bundle-edit-source">
                <Icon name="edit" size={14} /> Edit manifest
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              onClick={onDocument}
              data-testid="bundle-document-view"
            >
              Document
            </Button>
          </div>
        </div>
        {pinning ? (
          <div className="mx-auto mt-3 max-w-[90rem] rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-primary">
            Select a loop policy, step, graph node, or relationship to pin feedback.
          </div>
        ) : null}
      </div>

      <div className="mx-auto grid max-w-[90rem] gap-5 p-4 sm:p-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <main className="min-w-0">
          {view === "preview" && workflowPreview ? (
            <WorkflowPreview
              preview={workflowPreview}
              onRun={canComment ? setRunDiagram : undefined}
            />
          ) : view === "now" ? (
            <LinkedBundleNowWorkspace
              diagrams={diagrams}
              members={members}
              workflowNodes={workflowNodes}
              onFocus={focusNode}
            />
          ) : diagrams.length ? (
            <div className="grid gap-4" data-testid="bundle-advanced-view">
              <div className="rounded-xl border border-border bg-card p-4">
                <div className="font-mono text-2xs uppercase tracking-[0.12em] text-muted-foreground">
                  Advanced
                </div>
                <h2 className="mt-1 text-base font-semibold text-foreground">
                  Full graph and authored state
                </h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Inspect exact relationships, tiers, confidence, help state, and loop policy.
                </p>
              </div>
              {diagrams.map((diagram) => (
                <DiagramWorkspace
                  key={diagram.id}
                  diagram={diagram}
                  members={members}
                  workflowNodes={workflowNodes}
                  counts={counts}
                  reviewState={reviewState}
                  pinning={pinning}
                  canComment={canComment}
                  onReviewStateChange={onReviewStateChange}
                  onPin={onPin}
                  onReview={onReview}
                  shortId={shortId}
                  version={version}
                  canEdit={canEdit}
                  onSaved={onSaved}
                />
              ))}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-border p-8 text-center">
              <div className="text-sm font-medium text-foreground">No loop or graph yet</div>
              <p className="mt-1 text-xs text-muted-foreground">
                Ask an agent to add one, or edit the visible manifest.
              </p>
            </div>
          )}
        </main>
        <ArtifactShelf members={bundle.members} afterMain={view === "preview"} />
      </div>
      {runDiagram ? (
        <WorkflowRunDialog
          shortId={shortId}
          diagramId={runDiagram}
          agents={agents}
          open
          onOpenChange={(open) => {
            if (!open) setRunDiagram(null)
          }}
        />
      ) : null}
    </div>
  )
}
