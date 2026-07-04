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
import { StatusPanel } from "@/components/shared/status-panel"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { colorForName } from "@/lib/avatar-tints"
import { getInitials } from "@/lib/initials"
import { peopleQuery } from "@/lib/queries"
import { useDelayedPending } from "@/lib/use-delayed-pending"

// The people results grid geometry, defined once so the live grid and its skeleton
// can't drift. 240px min sizes each cell for a person row — an avatar + name beside a
// Follow button, on one line.
const PEOPLE_GRID = "grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3"

// The People directory — browse + search discoverable people and follow them. This is
// the discovery surface the follow graph was missing: a way to FIND someone to follow,
// not just stumble on an author chip. Empty query browses; typing searches (debounced).
export function People() {
  const [q, setQ] = useState("")
  const [debounced, setDebounced] = useState("")
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 220)
    return () => clearTimeout(t)
  }, [q])

  const { data, isPending, isError, isFetching, refetch } = useQuery(peopleQuery(debounced))
  // keepPreviousData holds the current results across searches, so isPending is only
  // the true first load; gate the skeleton so a cache-warm open flashes nothing.
  const showSkeleton = useDelayedPending(isPending)
  const people = data ?? []

  return (
    <PageShell className="flex flex-col gap-5">
      {/* Title + description + search form one tight header block (inner gaps);
          the PageShell gap makes the larger step down to the results below. */}
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

      <div>
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
        ) : people.length === 0 ? (
          <div data-testid="people-empty">
            <EmptyState
              icon={<Icon name="following" strokeWidth={1.75} />}
              title={debounced ? `No people match “${debounced}”.` : "No discoverable people yet."}
              description={
                debounced
                  ? "Try a different name or @handle."
                  : "People who turn on discoverability show up here."
              }
            />
          </div>
        ) : (
          <ul role="list" className={PEOPLE_GRID} data-testid="people-grid">
            {people.map((p) => (
              <PersonCard key={p.username} person={p} />
            ))}
          </ul>
        )}
      </div>
    </PageShell>
  )
}

// One directory row: identity links to the profile; Follow sits beside it (a sibling,
// not nested in the link — no interactive-inside-interactive). FollowButton self-hides
// for your own handle and signed-out viewers.
function PersonCard({ person: p }: { person: PublicProfile }) {
  const initials = getInitials(p.name ?? p.username)
  return (
    // Interactive card via the stretched link — the whole card is the click
    // target, so the hover edge-brighten sits on a genuinely clickable surface.
    <li className="relative flex items-center gap-3 rounded-xl border bg-card p-3 hover:border-foreground/25">
      <Link
        to="/users/$handle"
        params={{ handle: p.username }}
        data-testid={`people-card-${p.username}`}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-lg outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <Avatar className="size-9 shrink-0">
          {p.image && <AvatarImage src={p.image} alt={p.name ?? p.username} />}
          {/* Identity tint (stable per person) + the outline frame images get. */}
          <AvatarFallback
            className="font-medium text-scrim-foreground outline-1 -outline-offset-1 outline-foreground/10"
            style={{ backgroundColor: colorForName(p.name ?? p.username) }}
          >
            {initials}
          </AvatarFallback>
        </Avatar>
        <span className="min-w-0">
          {p.name && (
            <span className="block truncate text-sm font-medium text-foreground">{p.name}</span>
          )}
          <span className="block truncate font-mono text-2xs text-muted-foreground">
            @{p.username}
          </span>
          {p.profession && (
            <span className="block truncate text-sm text-muted-foreground">{p.profession}</span>
          )}
        </span>
      </Link>
      <FollowButton username={p.username} size="sm" className="relative z-10 shrink-0" />
    </li>
  )
}

const PERSON_CELLS = ["a", "b", "c", "d", "e", "f", "g", "h"]

// One person-row placeholder: PersonCard's box model — the p-3 row inset, a round
// size-9 avatar, name + @handle lines, and a Follow-button-sized block (size sm → h-8)
// — minus the card's border/background (those arrive with the person → zero CLS).
function PersonSkeletonCell() {
  return (
    <li className="flex items-center gap-3 p-3">
      <Skeleton className="size-9 shrink-0 rounded-full" />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-3 w-16" />
      </div>
      <Skeleton className="h-8 w-20 shrink-0 rounded-lg" />
    </li>
  )
}

// The results-region first-load placeholder — the SAME grid the live results use,
// filled with person-row silhouettes. The blocks are AT-hidden (baked into Skeleton);
// the region announces via role="status" + sr-only. Shared by the in-component first
// load and the route-level PeoplePending.
export function PeopleResultsSkeleton() {
  return (
    <div role="status">
      <span className="sr-only">Loading people…</span>
      <ul className={PEOPLE_GRID}>
        {PERSON_CELLS.map((k) => (
          <PersonSkeletonCell key={k} />
        ))}
      </ul>
    </div>
  )
}

// Route-level pending frame (the /people pendingComponent): the real static chrome —
// the PageHeader (always "People") and a SearchField-well silhouette — over the results
// skeleton. Shown on a cold nav while the auth guard resolves; the in-component
// PeopleResultsSkeleton (same grid) carries the data load, so the two are seamless.
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
