import { type ReactNode, type RefObject, useEffect, useRef } from "react"
import type { DirUser } from "@/api"
import { Icon } from "@/components/icons"
import { getInitials } from "@/lib/initials"
import { cn } from "@/lib/utils"
import { clamp } from "./lib/layout"
import type { AgentTarget, FrameGeom, Selection } from "./types"

/**
 * The anchored action menu on a text selection — "a menu about this text", not a
 * floating toolbar (chosen as Option B in the selection-actions proposal). The
 * popover surface sits ABOVE the selection with an arrow pointing down at it
 * (flipping below only when the top bar leaves no room), enters with a 150ms
 * fade+zoom from the arrow's origin, and TRACKS the text through scrolling via
 * the geometry subscription — the same physics as the pinned cards. When its
 * selection scrolls out of view it hides rather than clamping to an edge.
 *
 * The selection lives in the sandboxed iframe, so this positions against a
 * virtual anchor built from the frame-reported rect: the doc-absolute top
 * (sel.docTop, live against scroll) plus the capture-time horizontal span.
 */

// Vertical breathing room: the protruding arrow (6px) + a 4px gap.
const GAP = 10
// The workbench top bar's reach — flipping below happens past this line.
const TOP_LIMIT = 64

function MenuRow({
  testId,
  onClick,
  children,
}: {
  testId: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      // mousedown-preventDefault keeps the row from stealing the document
      // selection it acts on (same contract as the old pill's buttons).
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-foreground outline-none hover:bg-accent focus-visible:bg-accent [&_svg]:shrink-0"
    >
      {children}
    </button>
  )
}

export function SelectionMenu({
  sel,
  frameRef,
  subscribeGeom,
  asideWidth,
  agents,
  onComment,
  onAgent,
}: {
  sel: NonNullable<Selection>
  frameRef: RefObject<HTMLIFrameElement | null>
  subscribeGeom: (cb: (g: FrameGeom) => void) => () => void
  asideWidth: number
  agents: DirUser[]
  onComment: () => void
  onAgent: (agent: AgentTarget) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const { docTop } = sel
  // The selection's height and horizontal span are capture-time (the frame posts
  // one rect); only the vertical position is mapped live against scroll.
  const selH = Math.max(0, sel.vBottom - sel.vTop)
  const selMidX = (sel.vLeft + sel.vRight) / 2

  useEffect(() => {
    return subscribeGeom((g) => {
      const el = ref.current
      const fr = frameRef.current?.getBoundingClientRect()
      if (!el || !fr) return
      const selTop = fr.top + (docTop - g.scrollY)
      const selBottom = selTop + selH
      // Scrolled out of view: hide instead of clamping to an edge — a pinned-to-
      // nothing menu was exactly the old pill's tell.
      const visible = selBottom > TOP_LIMIT && selTop < window.innerHeight - 24
      el.style.visibility = visible ? "visible" : "hidden"
      el.style.pointerEvents = visible ? "auto" : "none"
      const w = el.offsetWidth
      const h = el.offsetHeight
      // Horizontal: centered on the selection, clamped into the document column;
      // the arrow keeps pointing at the selection even when the body clamps.
      const left = clamp(selMidX - w / 2, 12, Math.max(12, window.innerWidth - asideWidth - w - 12))
      const arrowX = clamp(selMidX - left, 14, w - 14)
      // Above the selection, arrow down; below it (arrow up) only when the top
      // bar leaves no room.
      const above = selTop - GAP - h >= TOP_LIMIT
      el.dataset.side = above ? "top" : "bottom"
      el.style.left = `${Math.round(left)}px`
      el.style.top = `${Math.round(above ? selTop - GAP - h : selBottom + GAP)}px`
      el.style.setProperty("--arrow-x", `${Math.round(arrowX)}px`)
      // The entrance zooms from the point of contact — the arrow.
      el.style.transformOrigin = `${Math.round(arrowX)}px ${above ? "100%" : "0%"}`
    })
  }, [subscribeGeom, frameRef, docTop, selH, selMidX, asideWidth])

  const usable = agents.filter((a): a is DirUser & { name: string } => !!a.name)

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: onMouseDown only prevents the menu from stealing the selection; the rows are buttons.
    <div
      ref={ref}
      data-testid="selection-menu"
      className={cn(
        // The popover grammar (surface + ring + pop shadow), entering with the
        // sanctioned 150ms fade+zoom. Invisible until the first geometry write
        // places it (the subscription fires synchronously on subscribe).
        "group fixed z-50 min-w-44 rounded-xl bg-popover p-1 shadow-[var(--shadow-pop)] ring-1 ring-foreground/10",
        "animate-in fade-in zoom-in-95 duration-150",
        "invisible left-0 top-0",
      )}
      onMouseDown={(e) => e.preventDefault()}
    >
      <MenuRow testId="comment-on-selection" onClick={onComment}>
        <Icon name="comments" size={15} className="text-muted-foreground" />
        Comment
      </MenuRow>
      {/* The agent-native moat, as rows: each agent you can hand this span to.
          One row recipe, however many agents — no nested picker to fall into. */}
      {usable.map((a) => (
        <MenuRow
          key={a.id}
          testId={usable.length === 1 ? "ask-agent" : `ask-agent-${a.id}`}
          onClick={() => onAgent({ id: a.id, name: a.name })}
        >
          <Icon name="sparkles" size={15} className="text-primary" />
          <span className="truncate">
            Ask {a.name.split(/\s+/)[0]}
            {usable.length === 1 ? " to revise" : ""}
          </span>
          {usable.length > 1 && (
            <span className="ml-auto grid size-5 shrink-0 place-items-center rounded-full bg-primary/10 font-mono text-2xs font-medium text-primary">
              {getInitials(a.name)}
            </span>
          )}
        </MenuRow>
      ))}
      {/* The tether: a rotated square riding the edge nearest the selection,
          its two exposed sides picking up the same hairline as the surface ring.
          Sitting above the selection (side=top) the arrow hangs off the bottom;
          flipped below (side=bottom) it rides the top. */}
      <span
        aria-hidden
        className={cn(
          "absolute size-3 rotate-45 bg-popover",
          "group-data-[side=top]:-bottom-1.5 group-data-[side=top]:border-b group-data-[side=top]:border-r",
          "group-data-[side=bottom]:-top-1.5 group-data-[side=bottom]:border-l group-data-[side=bottom]:border-t",
          "border-foreground/10",
        )}
        style={{ left: "calc(var(--arrow-x, 50%) - 6px)" }}
      />
    </div>
  )
}
