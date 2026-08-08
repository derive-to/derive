import { useQuery } from "@tanstack/react-query"
import { Link, useNavigate, useSearch } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import type { SearchHit } from "@/api"
import { useShell } from "@/components/chrome/shell-context"
import { Icon } from "@/components/icons"
import { AskButton } from "@/components/shared/ask-button"
import { EmptyState } from "@/components/shared/empty-state"
import { LoadError } from "@/components/shared/load-error"
import { PageHeader } from "@/components/shared/page-header"
import { PageShell } from "@/components/shared/page-shell"
import { SearchField } from "@/components/shared/search-field"
import { Skeleton } from "@/components/ui/skeleton"
import { splitMatches } from "@/lib/highlight"
import { searchQuery } from "@/lib/queries"
import { useDelayedPending } from "@/lib/use-delayed-pending"
import { useDocumentTitle } from "@/lib/use-document-title"
import { refFor } from "@/pages/artifact/parse-ref"

const MIN_CHARS = 2

// The full workspace search results page (/search?q=). The ⌘K palette is a quick 6-row peek; this
// is the deep, browsable view over the SAME hybrid (lexical + dense/semantic) endpoint — a ranked
// list with a snippet per artifact, semantic-only matches badged as meaning matches. Reached from
// the palette's "See all results" and by pressing Enter in a page's search field.
export function SearchResults() {
  const urlQ = (useSearch({ strict: false }) as { q?: string }).q ?? ""
  const nav = useNavigate()
  const { openAssistant } = useShell()
  const [input, setInput] = useState(urlQ)
  const [debounced, setDebounced] = useState(urlQ.trim())
  useDocumentTitle(urlQ.trim() ? `Search: ${urlQ.trim()}` : "Search")

  // Debounce keystrokes, and mirror the settled query into the URL so a search is shareable and the
  // back button works — `replace` so typing doesn't stack history entries.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(input.trim()), 250)
    return () => clearTimeout(t)
  }, [input])
  useEffect(() => {
    if (debounced === urlQ.trim()) return
    nav({ to: "/search", search: debounced ? { q: debounced } : {}, replace: true })
  }, [debounced, urlQ, nav])

  const q = debounced
  const active = q.length >= MIN_CHARS
  const { data, isError, isFetching, refetch } = useQuery(searchQuery(q))
  const hits = data?.hits ?? []

  // First-load only (keepPreviousData holds the list across refinements); gated so a warm cache
  // flashes nothing.
  const loading = active && isFetching && hits.length === 0
  const showSkeleton = useDelayedPending(loading)
  const nothing = active && !isFetching && hits.length === 0

  return (
    <PageShell width="wide" className="flex flex-col gap-5">
      <div className="flex flex-col gap-4">
        <PageHeader
          title="Search"
          subtitle="Find artifacts by keyword or meaning across this workspace."
        />
        <div className="flex items-center gap-2">
          <SearchField
            value={input}
            onValueChange={setInput}
            onEnter={(v) => setDebounced(v)}
            onAsk={(v) => openAssistant(v || undefined)}
            placeholder="Search all artifacts…"
            aria-label="Search all artifacts by keyword or meaning"
            testId="search-field"
            hotkey
            autoFocus
            loading={active && isFetching}
            className="flex-1"
          />
          {/* The ranked list answers "show me everything"; this answers "just tell me". Both stay
              on screen — asking never rearranges the results, because the answer arrives in the
              dock beside them (on a phone, on /chat). */}
          <AskButton text={input} testId="search-ask" />
        </div>
      </div>

      {!active ? (
        <EmptyState
          icon={<Icon name="search" strokeWidth={1.75} />}
          title="Search your workspace"
          description={`Find artifacts by keyword or by meaning — type at least ${MIN_CHARS} characters.`}
        />
      ) : loading ? (
        showSkeleton ? (
          <SearchResultsSkeleton />
        ) : null
      ) : isError ? (
        <LoadError
          title="Couldn’t run that search"
          testId="search-retry"
          onRetry={() => refetch()}
        />
      ) : nothing ? (
        <div data-testid="search-empty">
          <EmptyState
            icon={<Icon name="search" strokeWidth={1.75} />}
            title={`No artifacts match “${q}”.`}
            description="Try different words, or fewer of them."
          />
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <ul role="list" data-testid="search-results" className="flex flex-col gap-1">
            {hits.map((h) => (
              <HitRow key={h.short_id} hit={h} query={q} />
            ))}
          </ul>
          {data?.truncated && (
            <p className="px-1 text-xs text-muted-foreground">
              Showing the top matches — refine your search to narrow it.
            </p>
          )}
        </div>
      )}
    </PageShell>
  )
}

// One result row: the artifact title over its snippet. A semantic-only hit is badged and its
// snippet is the matching passage (no literal term to highlight); a literal hit highlights the
// matched term. The whole row links to the artifact.
function HitRow({ hit, query }: { hit: SearchHit; query: string }) {
  return (
    <li>
      <Link
        to="/artifacts/$ref"
        params={{ ref: refFor(hit) }}
        data-testid={`search-hit-${hit.short_id}`}
        className="flex items-start gap-3 rounded-lg px-3 py-2.5 outline-none hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <Icon name="all" size={16} className="mt-0.5 shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium text-foreground">{hit.title}</span>
            {hit.semantic && (
              <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground">
                meaning match
              </span>
            )}
          </div>
          {hit.snippet && (
            <span className="line-clamp-2 text-xs text-muted-foreground">
              {splitMatches(hit.snippet, query).map((seg, i) =>
                seg.match ? (
                  // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional + static
                  <span key={i} className="font-semibold text-foreground">
                    {seg.text}
                  </span>
                ) : (
                  // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional + static
                  <span key={i}>{seg.text}</span>
                ),
              )}
            </span>
          )}
        </div>
      </Link>
    </li>
  )
}

function SearchResultsSkeleton() {
  return (
    <ul role="list" className="flex flex-col gap-1" aria-hidden>
      {Array.from({ length: 6 }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length static skeleton
        <li key={i} className="flex items-start gap-3 px-3 py-2.5">
          <Skeleton className="mt-0.5 size-4 rounded" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Skeleton className="h-4 w-48 rounded" />
            <Skeleton className="h-3 w-full max-w-xl rounded" />
          </div>
        </li>
      ))}
    </ul>
  )
}

// Route-level pending frame (the /search pendingComponent): the static chrome + results skeleton,
// shown on a cold nav while the auth guard resolves. The in-component skeleton carries the data
// load, so the two are seamless.
export function SearchPending() {
  return (
    <PageShell width="wide" className="flex flex-col gap-5">
      <div className="flex flex-col gap-4">
        <PageHeader
          title="Search"
          subtitle="Find artifacts by keyword or meaning across this workspace."
        />
        <Skeleton className="h-8 w-full rounded-lg" />
      </div>
      <SearchResultsSkeleton />
    </PageShell>
  )
}
