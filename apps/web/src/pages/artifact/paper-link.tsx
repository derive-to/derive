import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { papersQuery } from "@/lib/queries"

// An imported paper's artifact is the paper itself, read as it renders. What surrounds the
// import (retrying it, attaching the code, the analysis of that code) lives on its /papers
// page; this line is the way there. A failed or empty read shows nothing: the paper reads
// the same either way.
export function PaperLink({ shortId }: { shortId: string }) {
  const papers = useQuery(papersQuery())
  if (papers.isError) return null
  const paper = papers.data?.find((p) => p.manifest_short_id === shortId)
  if (!paper) return null
  return (
    <div
      data-testid="paper-link"
      className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2 text-sm text-muted-foreground"
    >
      <span>Imported from arXiv</span>
      <Link
        to="/papers/$id"
        params={{ id: paper.id }}
        data-testid="paper-link-open"
        className="font-medium text-foreground hover:underline"
      >
        Import, code, and analysis
      </Link>
    </div>
  )
}
