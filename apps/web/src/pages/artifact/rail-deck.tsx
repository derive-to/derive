import { useCallback, useState } from "react"
import type { Viewer } from "@/api"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
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
  big,
}: {
  title: string
  onClick: () => void
  children: React.ReactNode
  testId?: string
  /** A bigger target + glyph for thumbs (the mobile sheet controls). */
  big?: boolean
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      title={title}
      aria-label={title}
      onClick={onClick}
      className={cn(
        "grid place-items-center rounded-md text-muted-foreground transition-colors hover:bg-hover hover:text-foreground",
        big ? "size-9 text-lg" : "size-[26px]",
      )}
    >
      {children}
    </button>
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

const initials = (v: Viewer) => (v.name || "?").slice(0, 2).toUpperCase()

// "Who's viewing" — an avatar stack that opens a popover listing each live viewer
// with their name, email (signed-in only), and role. Identity is server-derived
// (see the presence route), so nothing here is spoofable. Hidden when you're the
// only viewer. Built on the shared Popover, so it dismisses on outside/iframe click.
export function Presence({ viewers, selfId }: { viewers: Viewer[]; selfId?: string }) {
  const self = viewers.find((v) => v.id === selfId) ?? null
  const others = viewers.filter((v) => v.id !== selfId)
  if (others.length === 0) return null
  const ordered = self ? [self, ...others] : others
  const shown = ordered.slice(0, 4)
  const extra = ordered.length - shown.length
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="presence-trigger"
          aria-label={`${ordered.length} viewing — see who`}
          className="flex items-center gap-1.5 rounded-full py-0.5 pl-1 pr-2 transition-colors hover:bg-hover"
        >
          <div className="flex">
            {shown.map((v, i) => (
              <span
                key={v.id}
                className={cn(
                  "grid size-[22px] place-items-center rounded-full border-2 border-card font-mono text-2xs font-bold",
                  v.id === selfId ? "bg-primary text-primary-foreground" : "bg-accent text-primary",
                  i > 0 && "-ml-[7px]",
                )}
              >
                {initials(v)}
              </span>
            ))}
          </div>
          <span className="flex items-center gap-1 font-mono text-xs text-muted-foreground">
            <span className="size-1.5 rounded-full bg-success" />
            {ordered.length} viewing{extra > 0 ? ` (+${extra})` : ""}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" data-testid="presence-popover" className="w-64 p-1.5">
        <div className="px-2 py-1 font-mono text-2xs uppercase tracking-wide text-muted-foreground">
          {ordered.length} viewing now
        </div>
        <div className="max-h-[280px] overflow-auto">
          {ordered.map((v) => (
            <div key={v.id} className="flex items-center gap-2.5 rounded-md px-2 py-1.5">
              <span
                className={cn(
                  "grid size-7 shrink-0 place-items-center rounded-full font-mono text-2xs font-bold",
                  v.id === selfId ? "bg-primary text-primary-foreground" : "bg-accent text-primary",
                )}
              >
                {initials(v)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                  <span className="truncate">{v.name}</span>
                  {v.id === selfId && <span className="text-2xs text-muted-foreground">(you)</span>}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {v.email ?? "Anonymous viewer"}
                </span>
              </span>
              {v.role && (
                <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 font-mono text-2xs capitalize text-muted-foreground">
                  {v.role}
                </span>
              )}
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

// View analytics popover: totals, a 30-day sparkline, per-version split, and the
// most-recent viewers. Lazy — fetched when opened. Hidden if analytics is off.
