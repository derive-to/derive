import { API_BASE } from "@/api"

// A live, scaled-down render of an artifact's current version. Sandboxed and
// non-interactive (clicks fall through to the enclosing card); lazy so off-screen
// cards don't fetch. The token gradient shows through until the frame paints.
// Lives in a `group` card, so it picks up the accent border on card hover.
export function Thumb({ id, v }: { id: string; v: number }) {
  return (
    <div className="relative h-[116px] overflow-hidden rounded border border-border-soft bg-gradient-to-br from-accent to-secondary transition-colors group-hover:border-primary">
      <iframe
        title="Preview"
        aria-hidden
        tabIndex={-1}
        loading="lazy"
        src={`${API_BASE}/raw/${id}/v/${v}/index.html`}
        sandbox="allow-scripts"
        className="pointer-events-none absolute left-0 top-0 h-[250%] w-[250%] origin-top-left scale-[0.4] border-0 bg-white"
      />
    </div>
  )
}
