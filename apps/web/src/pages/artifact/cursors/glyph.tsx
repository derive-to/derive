import type { CSSProperties, ReactNode } from "react"
import { cn } from "@/lib/utils"

// The visual half of a live cursor. One shape — an arrow, filled in the peer's
// identity tint (the same color as their avatar). Raw colors here are either that
// identity tint (passed in) or fixed contrast values (#fff keyline, the lift
// shadow) that must survive both themes — not theme tokens.

/**
 * The pointer itself: a slim arrow filled in the peer's identity color, with a
 * white keyline so it reads on any artifact background and a soft drop shadow so
 * it lifts off the page.
 */
export function CursorGlyph({ color, size = 22 }: { color: string; size?: number }) {
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
 * The little name flag beside a cursor. Background is the peer's identity color;
 * text is fixed white for legibility on any of the identity tints. Carries
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
        "inline-block max-w-[160px] truncate rounded-md px-1.5 py-px text-xs font-medium leading-tight text-white",
        className,
      )}
      style={{ background: color, ...style }}
    >
      {children}
    </span>
  )
}
