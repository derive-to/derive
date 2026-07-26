import { Link } from "@tanstack/react-router"
import { ExternalLink } from "lucide-react"
import { type PrPreview, parseProgress } from "@/api"
import { Icon } from "@/components/icons"
import { Spinner } from "@/components/shared/spinner"
import { Button } from "@/components/ui/button"
import { ago } from "@/lib/time"

// One PR preview row: a pull-request glyph, the PR title (the "PR #n:" prefix the API
// adds is dropped — the number rides the GitHub link), the repo + sync state, then a
// subtle link out to the PR and the primary "View" into the mirrored collection.
export function PrPreviewRow({ pr }: { pr: PrPreview }) {
  const prog = parseProgress(pr.progress)
  const active =
    prog?.phase === "queued" || prog?.phase === "listing" || prog?.phase === "mirroring"
  // The API titles a preview "PR #<n>: <title>"; show just the <title> here.
  const label = pr.title.replace(/^PR #\d+:\s*/, "") || pr.title
  return (
    <div data-testid={`github-pr-${pr.pr_number}`} className="flex items-center gap-3 py-3">
      <Icon name="review" className="text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground">{label}</div>
        <div className="mt-0.5 flex items-center gap-1.5 truncate font-mono text-2xs text-muted-foreground">
          <a
            data-testid={`github-pr-link-${pr.pr_number}`}
            href={`https://github.com/${pr.repo}/pull/${pr.pr_number}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-0.5 hover:text-foreground hover:underline"
          >
            #{pr.pr_number}
            <ExternalLink className="size-3 shrink-0" aria-hidden />
          </a>
          <span aria-hidden>·</span>
          <span className="truncate">{pr.repo}</span>
          <span aria-hidden>·</span>
          {active ? (
            <span className="inline-flex items-center gap-1 text-primary">
              {/* Decorative — the "syncing…" text right here announces the state. */}
              <Spinner role="presentation" aria-label={undefined} className="size-3 shrink-0" />
              syncing…
            </span>
          ) : (
            <span>
              {pr.file_count} doc{pr.file_count === 1 ? "" : "s"}
              {pr.last_synced_at ? ` · synced ${ago(pr.last_synced_at)}` : ""}
            </span>
          )}
        </div>
      </div>
      <Button data-testid={`github-pr-view-${pr.pr_number}`} variant="outline" size="sm" asChild>
        <Link to="/" search={{ collection: pr.collection_id }}>
          View
        </Link>
      </Button>
    </div>
  )
}
