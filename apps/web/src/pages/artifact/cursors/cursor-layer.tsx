import { memo } from "react"
import { CursorGlyph, NameTag } from "@/components/cursor/glyph"
import { cn } from "@/lib/utils"
import type { CursorLayerHandle, PeerView, Ripple } from "./use-live-cursors"

// The peer-cursor overlay, painted over the artifact frame. Mount/unmount and
// styling are React's job; every-frame motion is driven straight on the DOM by
// the rAF loop in use-live-cursors (it writes `transform`/`opacity` on these
// nodes via the `register` ref). Ripple/peer colors are identity data.
export function CursorLayer({
  layer,
  onScrollDoc,
}: {
  layer: CursorLayerHandle
  onScrollDoc?: (dy: number) => void
}) {
  // Click an edge indicator to scroll ~70% of a screen toward those peers.
  const jump = (dir: "up" | "down") => {
    const h = layer.ref.current?.clientHeight ?? 600
    onScrollDoc?.(dir === "up" ? -h * 0.7 : h * 0.7)
  }
  return (
    <div
      ref={layer.ref}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-20 overflow-hidden"
      data-testid="cursor-layer"
    >
      {layer.roster.map((p) => (
        <RemoteCursor key={p.id} peer={p} register={layer.register} />
      ))}
      {layer.ripples.map((r) => (
        <RippleDot key={r.key} ripple={r} />
      ))}
      {layer.above.length > 0 && (
        <EdgeIndicator side="top" peers={layer.above} onClick={() => jump("up")} />
      )}
      {layer.below.length > 0 && (
        <EdgeIndicator side="bottom" peers={layer.below} onClick={() => jump("down")} />
      )}
    </div>
  )
}

// Peers scrolled out of view, collapsed into a cluster at the top/bottom edge
// (Miro/Figma style): how many, in their cursor colors, click to scroll toward
// them. Identity colors are data, not theme tokens, so they ride inline styles.
function EdgeIndicator({
  side,
  peers,
  onClick,
}: {
  side: "top" | "bottom"
  peers: PeerView[]
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={`cursor-offscreen-${side}`}
      title={`${peers.map((p) => p.name).join(", ")} ${side === "top" ? "above" : "below"}. Click to scroll.`}
      className={cn(
        "pointer-events-auto absolute left-1/2 z-30 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-card/95 px-2.5 py-1 text-xs font-semibold text-foreground shadow-[var(--shadow)] backdrop-blur transition-colors hover:bg-hover",
        side === "top" ? "top-2" : "bottom-2",
      )}
    >
      <span aria-hidden>{side === "top" ? "▲" : "▼"}</span>
      <span className="flex -space-x-1">
        {peers.slice(0, 3).map((p) => (
          <span
            key={p.id}
            className="size-3 rounded-full ring-1 ring-card"
            style={{ background: p.color }}
          />
        ))}
      </span>
      <span className="tabular-nums">{peers.length}</span>
    </button>
  )
}

const RemoteCursor = memo(function RemoteCursor({
  peer,
  register,
}: {
  peer: PeerView
  register: (id: string, el: HTMLElement | null) => void
}) {
  return (
    <div
      ref={(el) => register(peer.id, el)}
      data-testid="remote-cursor"
      data-cursor-id={peer.id}
      // Positioned at the origin; the animation loop translates it each frame.
      // Opacity transitions handle the leave fade smoothly.
      className="absolute left-0 top-0 will-change-transform transition-opacity duration-150"
    >
      <CursorGlyph color={peer.color} kind={peer.kind} emoji={peer.emoji} />
      <NameTag
        color={peer.color}
        className="absolute left-[15px] top-[16px] whitespace-nowrap transition-opacity duration-200"
      >
        {peer.name}
      </NameTag>
    </div>
  )
})

// A click ripple — a ring that expands and fades once. Positioned by percentage
// so it's resolution-independent (no layout read needed); the keyframe lives in
// globals.css (derive-cursor-ripple).
function RippleDot({ ripple }: { ripple: Ripple }) {
  return (
    <span
      className="absolute block size-5 rounded-full border-2"
      style={{
        left: `${ripple.x * 100}%`,
        top: `${ripple.y * 100}%`,
        borderColor: ripple.color,
        animation: "derive-cursor-ripple 620ms ease-out forwards",
      }}
    />
  )
}
