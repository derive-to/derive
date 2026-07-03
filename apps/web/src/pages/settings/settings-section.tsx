import type { ReactNode } from "react"
import { PageHeader } from "@/components/shared/page-header"

// A settings detail section: its own voice header (title + description + optional
// right-aligned actions) over its groups, in one generous column rhythm (gap-8,
// so the space between groups reads clearly larger than the space within a group).
// The loud voice title reflects where you are — "Settings" itself is only the
// quiet rail eyebrow. Each section leads with exactly one of these.
export function SettingsSection({
  title,
  description,
  actions,
  children,
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-8">
      <PageHeader title={title} subtitle={description} actions={actions} />
      {children}
    </div>
  )
}
