import { createFileRoute } from "@tanstack/react-router"
import { PageHeader } from "@/components/shared/page-header"
import { PageShell } from "@/components/shared/page-shell"
import { useDocumentTitle } from "@/lib/use-document-title"
import { PeopleDirectory } from "@/pages/people"

// The People directory is a browse surface — who you work with, who you follow —
// not a setting: nothing here is a decision you configure. It had a spell as
// Settings → People to reclaim a nav row; now it stands on its own path again
// (the old /settings/people address redirects back here). The directory owns its
// own search and data; this route supplies the shell and heading.
function PeoplePage() {
  useDocumentTitle("People")
  return (
    <PageShell width="wide" className="flex flex-col gap-5">
      <PageHeader
        title="People"
        subtitle="The people you work with, and what they’re making. Following someone surfaces their work in your library."
      />
      <PeopleDirectory />
    </PageShell>
  )
}

export const Route = createFileRoute("/people")({
  component: PeoplePage,
})
