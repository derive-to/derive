import type { CSSProperties, ReactNode } from "react"
import type { CursorKind } from "@/lib/cursors"
import { cn } from "@/lib/utils"

// The visual half of a live cursor, shared by the on-canvas overlay and the
// picker's preview so there's one definition of "what a cursor looks like".
// Raw colors here are identity data (the viewer's chosen tint) and fixed
// contrast values (#fff keyline, the lift shadow) — not theme tokens.

/**
 * The pointer itself. A crisper, slightly slimmer arrow than the old flat one:
 * filled in the viewer's color, a white keyline so it reads on any artifact
 * background, and a soft drop shadow so it lifts off the page. Swaps to the
 * chosen emoji when that style is selected.
 */
export function CursorGlyph({
  color,
  kind,
  emoji,
  size = 22,
}: {
  color: string
  kind: CursorKind
  emoji?: string
  size?: number
}) {
  if (kind === "emoji" && emoji) {
    return (
      <span
        aria-hidden="true"
        className="block leading-none drop-shadow-[0_2px_3px_rgba(0,0,0,0.28)]"
        style={{ fontSize: size }}
      >
        {emoji}
      </span>
    )
  }
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className="drop-shadow-[0_2px_3px_rgba(0,0,0,0.3)]"
    >
      <path
        d="M5 2.2 L5 19.7 L9.35 15.6 L12.1 21.5 L14.8 20.2 L12.05 14.4 L18 14.4 Z"
        fill={color}
        stroke="#fff"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  )
}

/**
 * The little name flag beside a cursor. Background is the viewer's identity
 * color; text is fixed white for legibility on any of the palette tints. Carries
 * `data-cursor-label` so the overlay's animation loop can fade it on stillness.
 */
export function NameTag({
  color,
  children,
  className,
  style,
}: {
  color: string
  children: ReactNode
  className?: string
  style?: CSSProperties
}) {
  return (
    <span
      data-cursor-label
      className={cn(
        "inline-block max-w-[160px] truncate rounded-[5px] px-1.5 py-px text-xs font-semibold leading-tight text-white",
        className,
      )}
      style={{ background: color, ...style }}
    >
      {children}
    </span>
  )
}
