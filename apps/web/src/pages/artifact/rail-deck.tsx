import { useCallback, useState } from "react"
import { cn } from "@/lib/utils"
import { clamp } from "./lib/layout"
import type { PinItem } from "./types"

export function Rail({
  pins,
  generalCount,
  active,
  onExpand,
  onHide,
  onDot,
}: {
  pins: PinItem[]
  generalCount: number
  active: string | null
  onExpand: () => void
  onHide: () => void
  onDot: (id: string) => void
}) {
  const [h, setH] = useState(600)
  const ref = useCallback((el: HTMLDivElement | null) => {
    if (el) setH(el.clientHeight)
  }, [])
  const total = pins.length + generalCount
  return (
    <>
      <button
        type="button"
        data-testid="comments-rail-expand"
        onClick={onExpand}
        title="Expand comments (c)"
        aria-label="Expand comments"
        className="flex h-[38px] w-full shrink-0 items-center justify-center gap-1.5 border-b border-border-soft text-foreground transition-colors hover:bg-hover"
      >
        <span className="text-xs">⟨</span>
        {total > 0 && (
          <span className="rounded-full bg-accent px-1.5 py-px font-mono text-2xs font-bold text-primary">
            {total}
          </span>
        )}
      </button>
      <div ref={ref} className="relative flex-1 overflow-hidden">
        {pins.map((p) => {
          const head = p.thread[0]
          if (!head) return null
          const id = head.thread_id
          const isActive = active === id
          return (
            <button
              type="button"
              key={id}
              data-testid={`comments-rail-dot-${id}`}
              onClick={() => onDot(id)}
              title={head.body_md}
              aria-label={`Jump to comment: ${head.body_md}`}
              className={cn(
                "absolute left-1/2 -translate-x-1/2 rounded-full border-2 border-card bg-primary p-0 transition-all",
                isActive ? "size-3.5 shadow-[0_0_0_3px_var(--ac-soft)]" : "size-2.5",
                !p.located && "opacity-40",
              )}
              style={{ top: clamp(p.desiredY + 6, 10, h - 14) }}
            />
          )
        })}
      </div>
      <button
        type="button"
        data-testid="comments-rail-hide"
        onClick={onHide}
        title="Hide comments"
        aria-label="Hide comments"
        className="flex h-[38px] w-full shrink-0 items-center justify-center border-t border-border-soft text-muted-foreground transition-colors hover:bg-hover"
      >
        ✕
      </button>
    </>
  )
}

export function IconBtn({
  title,
  onClick,
  children,
  testId,
}: {
  title: string
  onClick: () => void
  children: React.ReactNode
  testId?: string
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      title={title}
      aria-label={title}
      onClick={onClick}
      className="grid size-[26px] place-items-center rounded-md text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
    >
      {children}
    </button>
  )
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-0.5 pb-1.5 pt-0.5 font-mono text-2xs uppercase tracking-[0.06em] text-muted-foreground">
      {children}
    </div>
  )
}

// Who is viewing right now. Live over the presence SSE channel; self listed
// first as "you". Hidden when you're the only one here.
// Host presentation bar — shown when the artifact is a slide deck. Drives the
// deck over postMessage and fullscreens the wrapper (controls stay reachable).
export function DeckBar({
  deck,
  onPrev,
  onNext,
  onFullscreen,
}: {
  deck: { i: number; total: number }
  onPrev: () => void
  onNext: () => void
  onFullscreen: () => void
}) {
  const btn =
    "grid size-[30px] place-items-center rounded-lg border border-border bg-card text-foreground transition-colors hover:bg-hover disabled:pointer-events-none disabled:opacity-40"
  return (
    <div className="absolute bottom-3.5 left-1/2 z-[5] flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-card p-1.5 shadow-[var(--shadow)]">
      <button
        type="button"
        className={btn}
        data-testid="deck-prev"
        onClick={onPrev}
        disabled={deck.i <= 0}
        aria-label="Previous slide"
      >
        ‹
      </button>
      <span className="min-w-[52px] text-center font-mono text-sm text-muted-foreground">
        {deck.i + 1} / {deck.total}
      </span>
      <button
        type="button"
        className={btn}
        data-testid="deck-next"
        onClick={onNext}
        disabled={deck.i >= deck.total - 1}
        aria-label="Next slide"
      >
        ›
      </button>
      <button
        type="button"
        className={cn(btn, "ml-1")}
        data-testid="deck-fullscreen"
        onClick={onFullscreen}
        title="Present (fullscreen)"
        aria-label="Present fullscreen"
      >
        ⛶
      </button>
    </div>
  )
}

export function Presence({ viewers, self }: { viewers: string[]; self: string }) {
  const others = viewers.filter((v) => v !== self)
  if (others.length === 0) return null
  const ordered = [self, ...others].filter(Boolean)
  const shown = ordered.slice(0, 4)
  const extra = ordered.length - shown.length
  return (
    <div
      className="flex items-center gap-1.5"
      title={`${ordered.length} viewing: ${ordered.join(", ")}`}
    >
      <div className="flex">
        {shown.map((name, i) => (
          <span
            key={name}
            className={cn(
              "grid size-[22px] place-items-center rounded-full border-2 border-card font-mono text-2xs font-bold",
              name === self ? "bg-primary text-primary-foreground" : "bg-accent text-primary",
              i > 0 && "-ml-[7px]",
            )}
          >
            {(name || "?").slice(0, 2).toUpperCase()}
          </span>
        ))}
      </div>
      <span className="flex items-center gap-1 font-mono text-xs text-muted-foreground">
        <span className="size-1.5 rounded-full bg-success" />
        {ordered.length} viewing{extra > 0 ? ` (+${extra})` : ""}
      </span>
    </div>
  )
}

// View analytics popover: totals, a 30-day sparkline, per-version split, and the
// most-recent viewers. Lazy — fetched when opened. Hidden if analytics is off.
