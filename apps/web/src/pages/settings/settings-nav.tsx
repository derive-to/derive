import type { ReactNode } from "react"
import { Eyebrow } from "@/components/shared/section-eyebrow"
import { cn } from "@/lib/utils"

export type SettingsNavItem = {
  /** The section id — mirrors the `?tab=` value. */
  id: string
  label: string
  testId: string
  /** Optional trailing node (e.g. the Reports count badge). */
  badge?: ReactNode
}
export type SettingsNavGroup = { label: string; items: SettingsNavItem[] }

// The settings section nav — scope-grouped and container-query responsive. Once
// the pane is wide enough (@2xl) it's a sticky vertical rail with mono group
// labels; below that the group wrappers collapse to display:contents and every
// button reflows into ONE horizontal scroll-strip (labels hidden). One set of
// buttons across both layouts, so the settings-tab-* testids stay unique for
// Playwright's strict locators. Active = a neutral wash + re-ink at a constant
// weight (the nav rule: no tint tick, no weight change between states, no hover
// colour transition).
export function SettingsNav({
  groups,
  value,
  onSelect,
}: {
  groups: SettingsNavGroup[]
  value: string
  onSelect: (id: string) => void
}) {
  return (
    <nav
      aria-label="Settings sections"
      className="flex flex-row gap-1 overflow-x-auto pb-1 @2xl:flex-col @2xl:gap-5 @2xl:overflow-visible @2xl:pb-0"
    >
      {groups.map((group) => (
        <div key={group.label} className="contents @2xl:flex @2xl:flex-col @2xl:gap-0.5">
          <Eyebrow as="div" className="hidden px-2 pb-1 @2xl:block">
            {group.label}
          </Eyebrow>
          {group.items.map((item) => {
            const active = item.id === value
            return (
              <button
                key={item.id}
                type="button"
                data-testid={item.testId}
                aria-current={active ? "page" : undefined}
                onClick={() => onSelect(item.id)}
                className={cn(
                  "flex shrink-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm font-medium whitespace-nowrap outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring @2xl:w-full",
                  active
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:bg-secondary hover:text-foreground",
                )}
              >
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {item.badge}
              </button>
            )
          })}
        </div>
      ))}
    </nav>
  )
}
