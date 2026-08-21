import { type RefObject, useLayoutEffect, useRef } from "react"
import { Icon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { clamp } from "./lib/layout"
import type { FrameGeom, Selection } from "./types"

/**
 * The action bar on a text selection — a compact horizontal bar above the
 * selection, shown instantly, restyled onto the popover grammar: surface + ring +
 * pop shadow and an arrow tethering it to the highlighted text. No entrance
 * animation — it appears in place.
 *
 * Two verbs, and they are the two things a reader does with a sentence they stopped
 * on: say something about it, or change it. Edit only appears for someone who can
 * actually land the change — and it opens the mode with the caret already in that
 * block, so the fix costs one click instead of a trip to the header. Addressing an
 * agent is NOT a
 * third verb: that's an @mention typed into the composer (see the "Comments,
 * Sessions & Presence" RFC).
 *
 * The selection lives in the sandboxed iframe, so this positions against the
 * frame-reported rect: doc-absolute top (live against scroll, via the geometry
 * subscription — the pinned cards' physics) plus the capture-time horizontal
 * span. Positioning runs in a LAYOUT effect and the subscription fires
 * synchronously on subscribe, so the bar never paints unplaced.
 */

// Vertical breathing room: the protruding arrow (6px) + a 4px gap.
const GAP = 10
// The workbench top bar's reach — flipping below happens past this line.
const TOP_LIMIT = 64

export function SelectionMenu({
  sel,
  frameRef,
  subscribeGeom,
  asideWidth,
  onComment,
  editLabel,
  onEdit,
}: {
  sel: NonNullable<Selection>
  frameRef: RefObject<HTMLIFrameElement | null>
  subscribeGeom: (cb: (g: FrameGeom) => void) => () => void
  asideWidth: number
  onComment: () => void
  /** The edit verb's label. Absent ⇒ this viewer can't edit and the verb doesn't
   *  appear at all. */
  editLabel?: string
  onEdit?: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const { docTop } = sel
  // The selection's height and horizontal span are capture-time (the frame posts
  // one rect); only the vertical position is mapped live against scroll.
  const selH = Math.max(0, sel.vBottom - sel.vTop)
  const selMidX = (sel.vLeft + sel.vRight) / 2

  useLayoutEffect(() => {
    return subscribeGeom((g) => {
      const el = ref.current
      const fr = frameRef.current?.getBoundingClientRect()
      if (!el || !fr) return
      const selTop = fr.top + (docTop - g.scrollY)
      const selBottom = selTop + selH
      // Scrolled out of view: hide instead of clamping to an edge — a pinned-to-
      // nothing bar was exactly the old pill's tell.
      const visible = selBottom > TOP_LIMIT && selTop < window.innerHeight - 24
      el.style.visibility = visible ? "visible" : "hidden"
      el.style.pointerEvents = visible ? "auto" : "none"
      const w = el.offsetWidth
      const h = el.offsetHeight
      // Horizontal: centered on the selection, clamped into the document column;
      // the arrow keeps pointing at the selection even when the body clamps.
      const left = clamp(selMidX - w / 2, 12, Math.max(12, window.innerWidth - asideWidth - w - 12))
      const arrowX = clamp(selMidX - left, 14, w - 14)
      // Above the selection (as the pill always was); below only when the top
      // bar leaves no room.
      const above = selTop - GAP - h >= TOP_LIMIT
      el.dataset.side = above ? "top" : "bottom"
      el.style.left = `${Math.round(left)}px`
      el.style.top = `${Math.round(above ? selTop - GAP - h : selBottom + GAP)}px`
      el.style.setProperty("--arrow-x", `${Math.round(arrowX)}px`)
    })
  }, [subscribeGeom, frameRef, docTop, selH, selMidX, asideWidth])

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: onMouseDown only prevents the bar from stealing the selection; the controls inside are buttons.
    <div
      ref={ref}
      data-testid="selection-menu"
      className="group invisible fixed left-0 top-0 z-50 flex items-center gap-0.5 rounded-lg bg-popover p-1 shadow-[var(--shadow-pop)] ring-1 ring-foreground/10"
      onMouseDown={(e) => e.preventDefault()}
    >
      <Button
        variant="ghost"
        size="sm"
        title="Comment on the selection"
        data-testid="comment-on-selection"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onComment}
      >
        <Icon name="comments" size={15} className="text-muted-foreground" />
        Comment
      </Button>
      {editLabel && onEdit && (
        <Button
          variant="ghost"
          size="sm"
          title="Edit this text (e)"
          data-testid="edit-selection"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onEdit}
        >
          <Icon name="pencil" size={15} className="text-muted-foreground" />
          {editLabel}
        </Button>
      )}
      {/* The tether: a rotated square riding the edge nearest the selection,
          its two exposed sides picking up the same hairline as the surface ring. */}
      <span
        aria-hidden
        className="absolute size-3 rotate-45 border-foreground/10 bg-popover group-data-[side=bottom]:-top-1.5 group-data-[side=top]:-bottom-1.5 group-data-[side=bottom]:border-l group-data-[side=bottom]:border-t group-data-[side=top]:border-b group-data-[side=top]:border-r"
        style={{ left: "calc(var(--arrow-x, 50%) - 6px)" }}
      />
    </div>
  )
}
