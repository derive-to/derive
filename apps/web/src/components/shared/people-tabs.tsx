import { Link, useLocation } from "@tanstack/react-router"
import { cn } from "@/lib/utils"

// The People tab's two sub-views, as one segmented control: the People roster
// (/people — who you follow + find people) and the Activity feed (/following —
// recent work from the people/authors/folders you follow). Both are routes (feeds
// earn their own path, docs/decisions/0002); this just presents them as one surface
// so following someone and seeing what they make live together.
const TABS = [
  { to: "/people", label: "People", testId: "people-tab-people" },
  { to: "/following", label: "Activity", testId: "people-tab-activity" },
] as const

export function PeopleTabs() {
  const { pathname } = useLocation()
  return (
    <div
      role="tablist"
      aria-label="People views"
      className="inline-flex h-9 w-fit items-center gap-0.5 rounded-lg bg-muted p-0.5"
    >
      {TABS.map((t) => {
        const active = pathname === t.to
        return (
          <Link
            key={t.to}
            to={t.to}
            role="tab"
            aria-selected={active}
            data-testid={t.testId}
            className={cn(
              "inline-flex h-8 items-center rounded-md px-3 text-sm font-medium outline-none transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
              active
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
          </Link>
        )
      })}
    </div>
  )
}
