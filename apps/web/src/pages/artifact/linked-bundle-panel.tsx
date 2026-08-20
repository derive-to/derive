import type { Artifact, Comment } from "@/api"
import { Icon } from "@/components/icons"
import { Count } from "@/components/shared/section-eyebrow"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { parseAnchor } from "./types"

type LinkedBundle = NonNullable<Artifact["linked_bundle"]>
type Diagram = NonNullable<LinkedBundle["diagrams"]>[number]
type BundleMember = LinkedBundle["members"][number]

export type LinkedBundleReviewKind = "node" | "edge" | "policy"

/** Client twin of core's linkedBundleReviewId. The web package cannot import core
 * at runtime, so this tiny wire convention lives at the boundary and has a golden
 * test beside the component. */
export const linkedBundleReviewTarget = (
  diagramId: string,
  kind: LinkedBundleReviewKind,
  localId: string,
): string => `derive-${diagramId}-${kind}-${localId}`

export const linkedBundleCommentCounts = (comments: Comment[]): Map<string, number> => {
  const roots = new Map<string, Comment>()
  for (const comment of comments) {
    if (comment.state !== "open" && comment.state !== "addressed") continue
    if (!roots.has(comment.thread_id) || comment.id === comment.thread_id)
      roots.set(comment.thread_id, comment)
  }
  const counts = new Map<string, number>()
  for (const root of roots.values()) {
    const id = parseAnchor(root.anchor)?.element?.id
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  return counts
}

export const linkedBundleMemberDetail = (member: BundleMember): string =>
  [
    member.role,
    member.current_version ? `v${member.current_version}` : null,
    member.open_comment_count ? `${member.open_comment_count} open` : null,
  ]
    .filter(Boolean)
    .join(" · ") || (member.available ? "Artifact" : "Unavailable")

function ReviewRow({
  target,
  label,
  detail,
  count,
  onFocus,
}: {
  target: string
  label: string
  detail?: string
  count: number
  onFocus: (id: string) => void
}) {
  return (
    <button
      type="button"
      data-testid={`bundle-review-${target}`}
      onClick={() => onFocus(target)}
      className="group flex w-full items-center gap-2.5 border-t border-border-soft px-3 py-2.5 text-left transition-colors first:border-t-0 hover:bg-muted/50"
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">{label}</span>
        {detail ? (
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">{detail}</span>
        ) : null}
      </span>
      {count > 0 ? <Count>{count}</Count> : null}
      <Icon
        name="chevron-right"
        size={14}
        className="text-muted-foreground transition-transform group-hover:translate-x-0.5"
      />
    </button>
  )
}

function DiagramCard({
  diagram,
  members,
  counts,
  onFocus,
}: {
  diagram: Diagram
  members: Map<string, BundleMember>
  counts: Map<string, number>
  onFocus: (id: string) => void
}) {
  const nodeKind = diagram.type === "loop" ? "Step" : "Node"
  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="border-b border-border-soft px-3 py-3">
        <div className="font-mono text-2xs uppercase tracking-[0.12em] text-muted-foreground">
          {diagram.type}
        </div>
        <h3 className="mt-1 text-sm font-semibold leading-snug text-foreground">{diagram.title}</h3>
      </div>

      {diagram.type === "loop" ? (
        <div className="border-b border-border-soft bg-muted/20">
          {(["goal", "evaluate", "stop"] as const).map((key) => {
            const target = linkedBundleReviewTarget(diagram.id, "policy", key)
            const value = diagram[key] ?? "Not stated"
            return (
              <ReviewRow
                key={key}
                target={target}
                label={key[0]?.toUpperCase() + key.slice(1)}
                detail={value}
                count={counts.get(target) ?? 0}
                onFocus={onFocus}
              />
            )
          })}
        </div>
      ) : null}

      <div className="px-3 pb-1 pt-3 font-mono text-2xs uppercase tracking-[0.12em] text-muted-foreground">
        {diagram.nodes.length} {nodeKind.toLowerCase()}
        {diagram.nodes.length === 1 ? "" : "s"}
      </div>
      <div>
        {diagram.nodes.map((node) => {
          const target = linkedBundleReviewTarget(diagram.id, "node", node.id)
          const member = node.member ? members.get(node.member) : undefined
          const updated =
            !!node.basis_version &&
            !!member?.current_version &&
            member.current_version > node.basis_version
          return (
            <ReviewRow
              key={node.id}
              target={target}
              label={node.label}
              detail={
                member
                  ? `${node.state ? `${node.state} · ` : ""}Artifact · ${member.label}${member.current_version ? ` · v${member.current_version}` : ""}${updated ? " · updated" : ""}`
                  : node.member
                    ? `Artifact · ${node.member}`
                    : node.state
                      ? `${nodeKind} · ${node.state}`
                      : nodeKind
              }
              count={counts.get(target) ?? 0}
              onFocus={onFocus}
            />
          )
        })}
      </div>

      {diagram.edges.length ? (
        <details className="border-t border-border-soft">
          <summary className="cursor-pointer px-3 py-2.5 text-xs font-medium text-muted-foreground hover:text-foreground">
            {diagram.edges.length}{" "}
            {diagram.type === "loop"
              ? `transition${diagram.edges.length === 1 ? "" : "s"}`
              : `relationship${diagram.edges.length === 1 ? "" : "s"}`}
          </summary>
          <div className="border-t border-border-soft">
            {diagram.edges.map((edge, index) => {
              const local = `${index}-${edge.from}-${edge.to}`
              const target = linkedBundleReviewTarget(diagram.id, "edge", local)
              return (
                <ReviewRow
                  key={local}
                  target={target}
                  label={`${edge.from} → ${edge.to}`}
                  detail={edge.label}
                  count={counts.get(target) ?? 0}
                  onFocus={onFocus}
                />
              )
            })}
          </div>
        </details>
      ) : null}
    </section>
  )
}

export function LinkedBundlePanel({
  bundle,
  comments,
  canComment,
  pinning,
  onTogglePinning,
  onFocus,
}: {
  bundle: LinkedBundle
  comments: Comment[]
  canComment: boolean
  pinning: boolean
  onTogglePinning: () => void
  onFocus: (id: string) => void
}) {
  const diagrams = bundle.diagrams ?? []
  const loops = diagrams.filter((diagram) => diagram.type === "loop").length
  const graphs = diagrams.length - loops
  const counts = linkedBundleCommentCounts(comments)
  const members = new Map(bundle.members.map((member) => [member.id, member]))

  return (
    <div className="min-h-0 flex-1 overflow-auto" data-testid="linked-bundle-panel">
      <div className="border-b border-border px-3 py-3">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-foreground">Bundle map</div>
            <div className="mt-1 font-mono text-2xs text-muted-foreground">
              {bundle.members.length} artifacts · {loops} loop{loops === 1 ? "" : "s"} · {graphs}{" "}
              graph{graphs === 1 ? "" : "s"}
            </div>
          </div>
          {canComment ? (
            <Button
              variant={pinning ? "default" : "outline"}
              size="sm"
              data-testid="bundle-visual-pin"
              aria-pressed={pinning}
              onClick={onTogglePinning}
              className={cn("shrink-0", pinning && "shadow-sm")}
            >
              <Icon name="pin" size={14} weight={pinning ? "fill" : "regular"} />
              {pinning ? "Cancel pin" : "Pin comment"}
            </Button>
          ) : null}
        </div>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{bundle.purpose}</p>
        {pinning ? (
          <div className="mt-3 rounded-md border border-primary/30 bg-primary/5 px-2.5 py-2 text-xs text-primary">
            Click a loop step, policy, graph node, or edge in the artifact. Press Esc to cancel.
          </div>
        ) : null}
      </div>

      <div className="grid gap-3 p-3">
        <section className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="border-b border-border-soft px-3 py-3">
            <div className="font-mono text-2xs uppercase tracking-[0.12em] text-muted-foreground">
              Artifacts
            </div>
            <h3 className="mt-1 text-sm font-semibold leading-snug text-foreground">
              {bundle.members.length} living artifact{bundle.members.length === 1 ? "" : "s"}
            </h3>
          </div>
          <div>
            {bundle.members.map((member) => {
              const row = (
                <>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-foreground">
                      {member.label}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                      {linkedBundleMemberDetail(member)}
                    </span>
                  </span>
                  {member.available ? (
                    <Icon name="chevron-right" size={14} className="text-muted-foreground" />
                  ) : null}
                </>
              )
              const classes =
                "flex w-full items-center gap-2.5 border-t border-border-soft px-3 py-2.5 text-left first:border-t-0"
              return member.available ? (
                <a
                  key={member.id}
                  href={`/artifacts/${member.ref}`}
                  className={cn(classes, "transition-colors hover:bg-muted/50")}
                  data-testid={`bundle-member-${member.id}`}
                >
                  {row}
                </a>
              ) : (
                <div key={member.id} className={cn(classes, "opacity-60")}>
                  {row}
                </div>
              )
            })}
          </div>
        </section>
        {diagrams.map((diagram) => (
          <DiagramCard
            key={diagram.id}
            diagram={diagram}
            members={members}
            counts={counts}
            onFocus={onFocus}
          />
        ))}
      </div>
    </div>
  )
}
