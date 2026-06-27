import { Link } from "@tanstack/react-router"
import type { Collection } from "@/api"
import { Icon } from "@/components/icons"
import { prTitle, prUrl } from "@/lib/pr"
import { cn } from "@/lib/utils"

// The in-collection PR viewer: shown at the top of a repo-backed collection, it
// lists every open PR preview for that repo (the sidebar caps the same list at 5).
// Each row opens the PR's read-only doc collection; the arrow link opens the PR on
// GitHub. Returns null when the repo has no open PRs, so it never adds empty chrome.
export function RepoPullRequests({
  prs,
  repo,
  activeId,
}: {
  prs: Collection[]
  repo?: string
  activeId?: string
}) {
  if (prs.length === 0) return null
  return (
    <section
      data-testid="repo-pull-requests"
      className="mb-4 overflow-hidden rounded-xl border border-border bg-card"
    >
      <header className="flex items-center gap-2 border-b border-border-soft px-3.5 py-2.5">
        <Icon name="review" size={16} />
        <span className="font-display text-sm font-semibold text-foreground">Pull requests</span>
        <span className="font-mono text-2xs text-muted-foreground">{prs.length}</span>
      </header>
      <ul className="flex flex-col">
        {prs.map((pr) => {
          const active = pr.id === activeId
          return (
            <li
              key={pr.id}
              className="flex items-center border-b border-border-soft last:border-b-0"
            >
              <Link
                to="/"
                search={{ collection: pr.id }}
                data-testid={`repo-pr-${pr.id}`}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex min-w-0 flex-1 items-center gap-2.5 px-3.5 py-2.5 text-sm transition-colors hover:bg-hover",
                  active && "bg-accent text-accent-foreground hover:bg-accent",
                )}
              >
                <Icon name="review" size={15} className="shrink-0" />
                {pr.prNumber !== undefined && (
                  <span
                    className={cn(
                      "shrink-0 font-mono text-2xs text-muted-foreground",
                      active && "text-accent-foreground",
                    )}
                  >
                    #{pr.prNumber}
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate font-medium">
                  {prTitle(pr.title, pr.prNumber)}
                </span>
                <span
                  className={cn(
                    "shrink-0 font-mono text-2xs text-muted-foreground",
                    active && "text-accent-foreground",
                  )}
                >
                  {pr.count} doc{pr.count === 1 ? "" : "s"}
                </span>
              </Link>
              {repo && pr.prNumber !== undefined && (
                <a
                  href={prUrl(repo, pr.prNumber)}
                  target="_blank"
                  rel="noreferrer"
                  title={`Open PR #${pr.prNumber} on GitHub`}
                  aria-label={`Open PR #${pr.prNumber} on GitHub`}
                  data-testid={`repo-pr-${pr.id}-github`}
                  className="flex h-9 w-9 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
                >
                  <Icon name="link" size={15} />
                </a>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
