import { memo } from "react"
import { CursorGlyph, NameTag } from "@/components/cursor/glyph"
import type { CursorLayerHandle, PeerView, Ripple } from "./use-live-cursors"

// The peer-cursor overlay, painted over the artifact frame. Mount/unmount and
// styling are React's job; every-frame motion is driven straight on the DOM by
// the rAF loop in use-live-cursors (it writes `transform`/`opacity` on these
// nodes via the `register` ref). Ripple/peer colors are identity data.
export function CursorLayer({ layer }: { layer: CursorLayerHandle }) {
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
    </div>
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
// globals.css (dock-cursor-ripple).
function RippleDot({ ripple }: { ripple: Ripple }) {
  return (
    <span
      className="absolute block size-5 rounded-full border-2"
      style={{
        left: `${ripple.x * 100}%`,
        top: `${ripple.y * 100}%`,
        borderColor: ripple.color,
        animation: "dock-cursor-ripple 620ms ease-out forwards",
      }}
    />
  )
}
