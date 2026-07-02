import type { Viewer } from "@/api"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { getInitials } from "@/lib/initials"
import { cn } from "@/lib/utils"

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
      <span
        data-testid="deck-position"
        className="min-w-[52px] text-center font-mono text-sm text-muted-foreground"
      >
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

const initials = (v: Viewer) => getInitials(v.name)

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
            <span className="size-1.5 rounded-full bg-muted-foreground" />
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
