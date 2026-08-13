import { ChevronLeft, ChevronRight, Pause, Play, RotateCcw } from "lucide-react"
import type { Viewer } from "@/api"
import { Icon } from "@/components/icons"
import { Eyebrow } from "@/components/shared/section-eyebrow"
import { Avatar, AvatarFallback, AvatarGroup } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { getInitials } from "@/lib/initials"
import { cn } from "@/lib/utils"

// Host presentation bar — shown when the artifact is a slide deck, whether it
// announced itself or the injected client recognised one. Drives the deck over
// postMessage and puts it on the whole screen.
//
// While presenting it is the ONLY chrome left, which earns it two behaviours it
// doesn't need while reading: it fades once nothing has happened for a beat (a
// control bar parked over a projected slide is in the photo everyone takes), and it
// states how to get out, because a full-screen page with no visible exit is the
// oldest way to make someone feel trapped. Any pointer move or key brings it back.
export function DeckBar({
  deck,
  presenting = false,
  idle = false,
  onPrev,
  onNext,
  onPresent,
}: {
  deck: { i: number; total: number }
  presenting?: boolean
  idle?: boolean
  onPrev: () => void
  onNext: () => void
  onPresent: () => void
}) {
  return (
    <div
      data-testid="deck-bar"
      className={cn(
        "absolute bottom-3.5 left-1/2 z-5 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-card p-1.5 shadow-[var(--shadow)]",
        "transition-opacity duration-state motion-reduce:transition-none",
        // Hover keeps them up even after the idle timer: reaching for the bar is
        // exactly when it must not be fading away from your cursor.
        presenting && idle && "opacity-0 hover:opacity-100",
      )}
    >
      <Button
        variant="outline"
        size="icon-xs"
        data-testid="deck-prev"
        onClick={onPrev}
        disabled={deck.i <= 0}
        aria-label="Previous slide"
      >
        <ChevronLeft />
      </Button>
      <span
        data-testid="deck-position"
        className="min-w-13 text-center font-mono text-2xs tabular-nums text-muted-foreground"
      >
        {deck.i + 1} / {deck.total}
      </span>
      <Button
        variant="outline"
        size="icon-xs"
        data-testid="deck-next"
        onClick={onNext}
        disabled={deck.i >= deck.total - 1}
        aria-label="Next slide"
      >
        <ChevronRight />
      </Button>
      <Button
        variant="outline"
        size="icon-xs"
        className="ml-1"
        data-testid="deck-fullscreen"
        onClick={onPresent}
        aria-label={presenting ? "Leave present mode" : "Present (p)"}
        title={presenting ? "Leave present mode (Esc)" : "Present (p)"}
      >
        <Icon name={presenting ? "present-exit" : "present"} />
      </Button>
      {presenting && (
        <span className="pr-1.5 pl-0.5 font-mono text-2xs text-muted-foreground">Esc to exit</span>
      )}
    </div>
  )
}

export function VideoBar({
  video,
  onPrev,
  onNext,
  onToggle,
  onRestart,
}: {
  video: { i: number; total: number; playing: boolean; elapsedMs: number; durationMs: number }
  onPrev: () => void
  onNext: () => void
  onToggle: () => void
  onRestart: () => void
}) {
  const progress = Math.max(0, Math.min(100, (video.elapsedMs / video.durationMs) * 100))
  return (
    <div
      data-testid="video-bar"
      className="absolute bottom-3.5 left-1/2 z-5 flex min-w-72 -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-card p-1.5 shadow-[var(--shadow)]"
    >
      <Button
        data-testid="video-restart"
        variant="outline"
        size="icon-xs"
        onClick={onRestart}
        aria-label="Restart video"
      >
        <RotateCcw />
      </Button>
      <Button
        data-testid="video-prev"
        variant="outline"
        size="icon-xs"
        onClick={onPrev}
        disabled={video.i <= 0}
        aria-label="Previous scene"
      >
        <ChevronLeft />
      </Button>
      <Button
        data-testid="video-play-pause"
        variant="default"
        size="icon-xs"
        onClick={onToggle}
        aria-label={video.playing ? "Pause video" : "Play video"}
      >
        {video.playing ? <Pause /> : <Play />}
      </Button>
      <Button
        data-testid="video-next"
        variant="outline"
        size="icon-xs"
        onClick={onNext}
        disabled={video.i >= video.total - 1}
        aria-label="Next scene"
      >
        <ChevronRight />
      </Button>
      <span className="min-w-13 text-center font-mono text-2xs tabular-nums text-muted-foreground">
        {video.i + 1} / {video.total}
      </span>
      <span className="h-1.5 min-w-20 flex-1 overflow-hidden rounded-full bg-muted">
        <span className="block h-full bg-primary" style={{ width: `${progress}%` }} />
      </span>
    </div>
  )
}

const initials = (v: Viewer) => getInitials(v.name)

// The identity tint for a presence fallback: self is the soft brand tint, other
// viewers the neutral wash (caller-owned per the Avatar recipe).
const presenceTint = (self: boolean) =>
  self ? "bg-primary/10 text-primary" : "bg-accent text-foreground"

// "Who's viewing" — an avatar stack that opens a popover listing each live viewer
// by their public handle and role. Identity is server-derived AND handle-based
// (see the presence route: never the account name or email — presence rides
// wildcard-CORS SSE), so nothing here is spoofable or leaky. Hidden when you're
// the only viewer. Built on the shared Popover, so it dismisses on outside/iframe
// click.
export function Presence({
  viewers,
  selfId,
  compact,
}: {
  viewers: Viewer[]
  selfId?: string
  /** Tight header (mobile): fewer avatars + a count only, no "viewing" word. */
  compact?: boolean
}) {
  const self = viewers.find((v) => v.id === selfId) ?? null
  const others = viewers.filter((v) => v.id !== selfId)
  if (others.length === 0) return null
  const ordered = self ? [self, ...others] : others
  const shown = ordered.slice(0, compact ? 3 : 4)
  const extra = ordered.length - shown.length
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          data-testid="presence-trigger"
          aria-label={`${ordered.length} viewing — see who`}
          className="rounded-full py-0.5 pr-2 pl-1"
        >
          <AvatarGroup>
            {shown.map((v) => (
              <Avatar key={v.id} size="sm">
                <AvatarFallback
                  className={cn("font-mono text-2xs font-medium", presenceTint(v.id === selfId))}
                >
                  {initials(v)}
                </AvatarFallback>
              </Avatar>
            ))}
          </AvatarGroup>
          <span className="flex items-center gap-1 font-mono text-2xs tabular-nums text-muted-foreground">
            <span className="size-1.5 rounded-full bg-muted-foreground" />
            {ordered.length}
            {compact ? "" : ` viewing${extra > 0 ? ` (+${extra})` : ""}`}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" data-testid="presence-popover" className="w-64 gap-0 p-1.5">
        <Eyebrow as="div" className="px-2 py-1 tabular-nums">
          {ordered.length} viewing now
        </Eyebrow>
        <div className="max-h-70 overflow-auto">
          {ordered.map((v) => (
            <div key={v.id} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5">
              <Avatar className="size-7">
                <AvatarFallback
                  className={cn("font-mono text-2xs font-medium", presenceTint(v.id === selfId))}
                >
                  {initials(v)}
                </AvatarFallback>
              </Avatar>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                  <span className="truncate">{v.name}</span>
                  {v.id === selfId && <span className="text-sm text-muted-foreground">(you)</span>}
                </span>
              </span>
              {v.role && (
                <Badge shape="pill" className="capitalize">
                  {v.role}
                </Badge>
              )}
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
