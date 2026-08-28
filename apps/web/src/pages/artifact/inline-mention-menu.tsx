import type { DirUser } from "@/api"
import { Eyebrow } from "@/components/shared/section-eyebrow"
import { cn } from "@/lib/utils"
import type { InlineMentionMenuState } from "./use-inline-edit"

/** The host half of rendered-document mentions. The sandboxed document reports its
 * caret and holds the replacement Range; this small, fixed popover keeps the
 * authenticated directory and its familiar keyboard grammar in the app shell. */
export function InlineMentionMenu({
  menu,
  onChoose,
}: {
  menu: InlineMentionMenuState
  onChoose: (user: DirUser) => void
}) {
  return (
    <div
      role="listbox"
      aria-label="Mention a collaborator"
      data-testid="inline-mention-menu"
      className="fixed z-50 w-72 overflow-hidden rounded-xl bg-popover p-1 shadow-[var(--shadow-pop)] ring-1 ring-foreground/10"
      style={{ left: menu.position.left, top: menu.position.top }}
    >
      <Eyebrow as="div" className="px-2.5 py-2">
        Mention a collaborator
      </Eyebrow>
      {menu.loading ? (
        <div className="px-2.5 py-2 text-sm text-muted-foreground">Finding people…</div>
      ) : menu.users.length ? (
        menu.users.map((user, index) => {
          const handle = user.handle as string
          const label = user.name || handle
          return (
            <button
              key={user.id}
              type="button"
              role="option"
              aria-selected={index === menu.active}
              data-testid="inline-mention-option"
              // Preserve the iframe selection through a pointer choice; the frame
              // owns the exact Range that gets replaced when this button is clicked.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onChoose(user)}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left outline-none transition-colors hover:bg-accent focus-visible:bg-accent",
                index === menu.active && "bg-accent",
              )}
            >
              <span
                aria-hidden="true"
                className="grid size-7 shrink-0 place-items-center rounded-full bg-secondary text-xs font-medium text-secondary-foreground"
              >
                {label.slice(0, 1).toUpperCase()}
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{label}</span>
                <span className="block truncate font-mono text-xs text-muted-foreground">
                  @{handle}
                </span>
              </span>
            </button>
          )
        })
      ) : (
        <div className="px-2.5 py-2 text-sm text-muted-foreground">No matching collaborators</div>
      )}
      {!menu.loading && menu.users.length > 0 && (
        <div className="px-2.5 pt-1.5 pb-1 text-xs text-muted-foreground">
          <span className="font-mono">↑↓</span> to choose · <span className="font-mono">↵</span> to
          insert
        </div>
      )}
    </div>
  )
}
