import { cn } from "@/lib/utils"

// Stable per-author tints, so people stay recognisable across avatars + threads.
const AUTHOR_TINTS = [
  "#7c6cbd",
  "#3c6e2f",
  "#a04425",
  "#2f6e6e",
  "#9a5fb0",
  "#b08322",
  "#4a63b8",
  "#9a4a6b",
] as const

export function colorFor(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return AUTHOR_TINTS[h % AUTHOR_TINTS.length] ?? AUTHOR_TINTS[0]
}

// Initials avatar tinted by a hash of the author name. The tint is data-driven
// (one of a fixed palette) so it stays inline; everything else is utilities.
export function ColoredAvatar({
  name,
  size = 17,
  className,
}: {
  name: string
  size?: number
  className?: string
}) {
  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center rounded-full font-mono font-bold text-white",
        className,
      )}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.5),
        background: colorFor(name),
      }}
    >
      {(name || "?").slice(0, 2).toUpperCase()}
    </span>
  )
}
