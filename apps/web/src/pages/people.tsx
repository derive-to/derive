import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import type { PublicProfile } from "@/api"
import { Icon } from "@/components/icons"
import { EmptyState } from "@/components/shared/empty-state"
import { FollowButton } from "@/components/shared/follow-button"
import { PageHeader } from "@/components/shared/page-header"
import { PageShell } from "@/components/shared/page-shell"
import { SearchField } from "@/components/shared/search-field"
import { SectionEyebrow } from "@/components/shared/section-eyebrow"
import { StatusPanel } from "@/components/shared/status-panel"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { colorForName } from "@/lib/avatar-tints"
import { getInitials } from "@/lib/initials"
import { peopleQuery, workspacePeopleQuery } from "@/lib/queries"
import { useDelayedPending } from "@/lib/use-delayed-pending"
import { cn } from "@/lib/utils"

// The People directory — the discovery surface the follow graph needs: a way to FIND
// someone to follow, not just stumble on an author chip. Reconceived as a scannable
// directory of full-width rows (a directory's job is "read a name, follow" — list work,
// not a card wall), with a deliberate BROWSE-by-default state: an empty query isn't
// "nothing", it's the people you work with + everyone discoverable, framed as such.
// Typing searches (debounced); the current results stay put (dimmed) while the next set
// loads — never a flash.
export function People() {
  const [q, setQ] = useState("")
  const [debounced, setDebounced] = useState("")
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 220)
    return () => clearTimeout(t)
  }, [q])

  const { data, isPending, isError, isFetching, isPlaceholderData, refetch } = useQuery(
    peopleQuery(debounced),
  )
  // keepPreviousData holds the current results across searches, so isPending is only the
  // true first load; gate the skeleton so a cache-warm open flashes nothing.
  const showSkeleton = useDelayedPending(isPending)
  const people = data ?? []
  const searching = debounced.length > 0
  const browsing = !searching

  // The people you actually work with lead the browse view (Slack's mental model); the
  // global discoverable directory follows, de-duplicated against your workspace. A search
  // collapses to one flat result list — sectioning matches by workspace would just split
  // them. Regardless of discoverability, so teammates are always reachable here.
  const { data: mates = [] } = useQuery(workspacePeopleQuery())
  const mateHandles = new Set(mates.map((m) => m.username))
  const globalPeople = browsing ? people.filter((p) => !mateHandles.has(p.username)) : people
  // Empty only when there's genuinely nothing for the current mode: a search shows its own
  // "no match" regardless of teammates; browse is empty only if BOTH sources are.
  const nothing = searching ? people.length === 0 : people.length === 0 && mates.length === 0

  return (
    <PageShell className="flex flex-col gap-5">
      {/* Title + description + search — one tight header block; the PageShell gap makes
          the larger step down to the results. */}
      <div className="flex flex-col gap-4">
        <PageHeader title="People" subtitle="Find people on Derive and follow their work." />
        <SearchField
          value={q}
          onValueChange={setQ}
          placeholder="Search people…"
          aria-label="Search people by name or handle"
          testId="people-search"
          hotkey
          loading={isFetching && !isPending}
        />
      </div>

      {isPending ? (
        showSkeleton ? (
          <PeopleResultsSkeleton />
        ) : null
      ) : isError ? (
        // A failed fetch is status, not emptiness — the danger tone grammar.
        <StatusPanel
          tone="danger"
          title="Couldn’t load people"
          description="This is usually temporary."
          action={
            <Button
              variant="outline"
              size="sm"
              data-testid="people-retry"
              onClick={() => refetch()}
            >
              Try again
            </Button>
          }
        />
      ) : nothing ? (
        <div data-testid="people-empty">
          <EmptyState
            icon={<Icon name={searching ? "search" : "following"} strokeWidth={1.75} />}
            // Two distinct tones: a search that found nothing is corrective ("try
            // another"); the browse state finding nothing is explanatory, not an error.
            title={searching ? `No people match “${debounced}”.` : "No discoverable people yet."}
            description={
              searching
                ? "Try a different name or @handle."
                : "People who turn on discoverability show up here."
            }
          />
        </div>
      ) : (
        // Stale results stay visible but dim while the next search loads (placeholder
        // data), so the directory never blanks mid-type.
        <div
          className={cn(
            "flex flex-col gap-6",
            isPlaceholderData && "opacity-60 transition-opacity",
          )}
        >
          {/* Browse leads with the people you work with — teammates first, then the wider
              directory. A search collapses to a single "Results" list. */}
          {browsing && mates.length > 0 && (
            <PeopleGroup label="Your workspaces" people={mates} testId="people-workspace" />
          )}
          {globalPeople.length > 0 && (
            <PeopleGroup
              label={searching ? "Results" : mates.length > 0 ? "Everyone on Derive" : "Everyone"}
              people={globalPeople}
              testId="people-results"
            />
          )}
        </div>
      )}
    </PageShell>
  )
}

// One labelled directory section: a mono eyebrow + count over a list of person rows.
// The count frames the state (browsing everyone vs a result set) as intentional.
function PeopleGroup({
  label,
  people,
  testId,
}: {
  label: string
  people: PublicProfile[]
  testId: string
}) {
  return (
    <section>
      <SectionEyebrow className="mb-3" count={people.length}>
        {label}
      </SectionEyebrow>
      <ul role="list" data-testid={testId} className="flex flex-col gap-2">
        {people.map((p) => (
          <PersonRow key={p.username} person={p} />
        ))}
      </ul>
    </section>
  )
}

// One directory row: identity links to the profile (stretched link over the whole row);
// Follow sits beside it as a sibling — not nested in the link (no interactive-inside-
// interactive). FollowButton self-hides for your own handle and signed-out viewers.
function PersonRow({ person: p }: { person: PublicProfile }) {
  const initials = getInitials(p.name ?? p.username)
  return (
    <li className="relative flex items-center gap-3 rounded-lg border bg-card px-3.5 py-3 hover:border-foreground/25">
      <Link
        to="/users/$handle"
        params={{ handle: p.username }}
        data-testid={`people-card-${p.username}`}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-md outline-none after:absolute after:inset-0 after:rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <Avatar className="size-10 shrink-0">
          {p.image && <AvatarImage src={p.image} alt={p.name ?? p.username} />}
          <AvatarFallback
            className="font-medium text-scrim-foreground outline-1 -outline-offset-1 outline-foreground/10"
            style={{ backgroundColor: colorForName(p.name ?? p.username) }}
          >
            {initials}
          </AvatarFallback>
        </Avatar>
        <span className="flex min-w-0 flex-col">
          {/* Name + @handle share a line (name is the read, handle is the identity);
              profession sits below as the muted one-liner — the "read one line" a
              directory scan needs. */}
          <span className="flex min-w-0 items-baseline gap-2">
            {p.name && (
              <span className="truncate text-sm font-medium text-foreground">{p.name}</span>
            )}
            <span className="shrink-0 truncate font-mono text-2xs text-muted-foreground">
              @{p.username}
            </span>
          </span>
          {p.profession && (
            <span className="truncate text-sm text-muted-foreground">{p.profession}</span>
          )}
        </span>
      </Link>
      <FollowButton username={p.username} size="sm" className="relative z-10 shrink-0" />
    </li>
  )
}

const PERSON_CELLS = ["a", "b", "c", "d", "e", "f"]

// One person-row placeholder: PersonRow's box model — the px-3.5 py-3 row inset, a round
// size-10 avatar, a name/handle line over a profession line, and a Follow-button-sized
// block (sm → h-8) — minus the border/background (those arrive with the person → zero CLS).
function PersonSkeletonRow() {
  return (
    <li className="flex items-center gap-3 px-3.5 py-3">
      <Skeleton className="size-10 shrink-0 rounded-full" />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-3.5 w-24" />
      </div>
      <Skeleton className="h-8 w-20 shrink-0 rounded-lg" />
    </li>
  )
}

// The results-region first-load placeholder — the SAME row stack the live results use,
// filled with person-row silhouettes. The blocks are AT-hidden (baked into Skeleton);
// the region announces via role="status" + sr-only. Shared by the in-component first
// load and the route-level PeoplePending.
export function PeopleResultsSkeleton() {
  return (
    <div role="status">
      <span className="sr-only">Loading people…</span>
      <ul className="flex flex-col gap-2">
        {PERSON_CELLS.map((k) => (
          <PersonSkeletonRow key={k} />
        ))}
      </ul>
    </div>
  )
}

// Route-level pending frame (the /people pendingComponent): the real static chrome — the
// PageHeader (always "People") and a SearchField-well silhouette — over the results
// skeleton. Shown on a cold nav while the auth guard resolves; the in-component
// PeopleResultsSkeleton (same rows) carries the data load, so the two are seamless.
export function PeoplePending() {
  return (
    <PageShell className="flex flex-col gap-5">
      <div className="flex flex-col gap-4">
        <PageHeader title="People" subtitle="Find people on Derive and follow their work." />
        {/* The SearchField's InputGroup well is h-8, rounded-lg. */}
        <Skeleton className="h-8 w-full rounded-lg" />
      </div>
      <PeopleResultsSkeleton />
    </PageShell>
  )
}
