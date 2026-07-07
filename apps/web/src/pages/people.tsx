import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import type { PublicProfile } from "@/api"
import { Icon } from "@/components/icons"
import { EmptyState } from "@/components/shared/empty-state"
import { FollowButton } from "@/components/shared/follow-button"
import { PageHeader } from "@/components/shared/page-header"
import { PageShell } from "@/components/shared/page-shell"
import { PeopleTabs } from "@/components/shared/people-tabs"
import { SearchField } from "@/components/shared/search-field"
import { SectionEyebrow } from "@/components/shared/section-eyebrow"
import { StatusPanel } from "@/components/shared/status-panel"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { useAuth } from "@/ctx"
import { colorForName } from "@/lib/avatar-tints"
import { getInitials } from "@/lib/initials"
import { followsQuery, peopleQuery, profilePeopleQuery, workspacePeopleQuery } from "@/lib/queries"
import { useDelayedPending } from "@/lib/use-delayed-pending"
import { cn } from "@/lib/utils"

// The People tab — who you follow, plus a way to find the people you work with. It folds
// the old Following nav item in: the browse (no-query) view leads with the people you
// follow, then your workspace teammates — the two people-sets worth seeing without typing.
// Everyone else on Derive lives behind the search (debounced); results stay put (dimmed)
// while the next set loads — never a flash.
export function People() {
  const [q, setQ] = useState("")
  const [debounced, setDebounced] = useState("")
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 220)
    return () => clearTimeout(t)
  }, [q])

  const { me } = useAuth()
  const searching = debounced.length > 0

  // A search spans everyone on Derive; browse shows only who you follow + your workspace
  // teammates (a full directory isn't scrolled, it's searched), so the global people query
  // only runs while searching.
  const { data, isError, isFetching, isPlaceholderData, refetch } = useQuery({
    ...peopleQuery(debounced),
    enabled: searching,
  })
  const { data: mates = [], isPending: matesPending } = useQuery(workspacePeopleQuery())
  const { data: follows = [], isPending: followsPending } = useQuery(followsQuery())
  // Follow rows carry each person's handle/name/avatar but not their profession; pull the
  // full "following" profiles to fill in the role line. The follows query stays the source
  // of truth for WHICH people show (so a follow/unfollow reflects instantly) — this enriches.
  const { data: followingProfiles = [] } = useQuery({
    ...profilePeopleQuery(me?.username ?? "", "following"),
    enabled: !!me?.username,
  })
  const professionByHandle = new Map(
    followingProfiles.map((p) => [p.username.toLowerCase(), p.profession ?? null]),
  )

  const people = data ?? []
  const mateHandles = new Set(mates.map((m) => m.username.toLowerCase()))

  // People you follow, as directory rows — the follow row resolves handle/name/avatar
  // server-side; profession is layered in from the following profiles above.
  const followed: PublicProfile[] = follows
    .filter((f) => f.kind === "user")
    .map((f) => {
      const username = f.handle ?? f.target
      return {
        username,
        name: f.name ?? null,
        image: f.image ?? null,
        profession: professionByHandle.get(username.toLowerCase()) ?? null,
      }
    })
  const followedHandles = new Set(followed.map((p) => p.username.toLowerCase()))
  // Don't list a teammate twice if you already follow them.
  const mateOnly = mates.filter((m) => !followedHandles.has(m.username.toLowerCase()))

  // Search results: everyone on Derive, but float the people you work with to the top
  // ("anyone, but focus on your workspace") and drop yourself.
  const results = people
    .filter((p) => p.username.toLowerCase() !== me?.username?.toLowerCase())
    .sort(
      (a, b) =>
        Number(mateHandles.has(b.username.toLowerCase())) -
        Number(mateHandles.has(a.username.toLowerCase())),
    )

  // Loading is per-mode: a search waits on the people query's first page; browse waits on
  // your follows + teammates. keepPreviousData holds prior results, so the skeleton is only
  // the true first load — gated by useDelayedPending so a cache-warm open flashes nothing.
  const loading = searching ? isFetching && people.length === 0 : followsPending || matesPending
  const showSkeleton = useDelayedPending(loading)

  // Empty only when there's genuinely nothing for the current mode.
  const nothing = searching ? results.length === 0 : followed.length === 0 && mateOnly.length === 0

  return (
    <PageShell className="flex flex-col gap-5">
      {/* Title + description + search — one tight header block; the PageShell gap makes
          the larger step down to the results. */}
      <div className="flex flex-col gap-4">
        <PageHeader title="People" subtitle="Find people on Derive and follow their work." />
        <PeopleTabs />
        <SearchField
          value={q}
          onValueChange={setQ}
          placeholder="Search people…"
          aria-label="Search people by name or handle"
          testId="people-search"
          hotkey
          loading={isFetching}
        />
      </div>

      {loading ? (
        showSkeleton ? (
          <PeopleResultsSkeleton />
        ) : null
      ) : searching && isError ? (
        // A failed search is status, not emptiness — the danger tone grammar.
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
            // A search that found nothing is corrective ("try another"); an empty browse
            // means you follow no one yet — point at the search, not discoverability.
            title={
              searching ? `No people match “${debounced}”.` : "You’re not following anyone yet."
            }
            description={
              searching
                ? "Try a different name or @handle."
                : "Search above to find people to follow."
            }
          />
        </div>
      ) : (
        // Stale results stay visible but dim while the next search loads (placeholder
        // data), so the list never blanks mid-type.
        <div
          className={cn(
            "flex flex-col gap-6",
            isPlaceholderData && "opacity-60 transition-opacity",
          )}
        >
          {searching ? (
            <PeopleGroup
              label="Results"
              people={results}
              testId="people-results"
              mateHandles={mateHandles}
              markWorkspace
            />
          ) : (
            <>
              {/* Browse leads with who you follow, then the people you work with — the two
                  people-sets worth seeing without typing. Everyone else lives behind search. */}
              {followed.length > 0 && (
                <PeopleGroup
                  label="Following"
                  people={followed}
                  testId="people-following"
                  mateHandles={mateHandles}
                  markWorkspace
                />
              )}
              {mateOnly.length > 0 && (
                <PeopleGroup label="Your workspaces" people={mateOnly} testId="people-workspace" />
              )}
            </>
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
  mateHandles,
  markWorkspace = false,
}: {
  label: string
  people: PublicProfile[]
  testId: string
  // Handles of your workspace members; rows in this set get an "In your workspace" tag.
  mateHandles?: Set<string>
  // Off for the "Your workspaces" group (the section label already says it) — on where
  // a member is mixed in with others (Following, search Results).
  markWorkspace?: boolean
}) {
  return (
    <section>
      <SectionEyebrow className="mb-3" count={people.length}>
        {label}
      </SectionEyebrow>
      <ul role="list" data-testid={testId} className="flex flex-col gap-2">
        {people.map((p) => (
          <PersonRow
            key={p.username}
            person={p}
            inWorkspace={markWorkspace && !!mateHandles?.has(p.username.toLowerCase())}
          />
        ))}
      </ul>
    </section>
  )
}

// One directory row: identity links to the profile (stretched link over the whole row);
// the workspace tag + Follow sit beside it as siblings — not nested in the link (no
// interactive-inside-interactive). FollowButton self-hides for your own handle and
// signed-out viewers. `inWorkspace` tags a person you share a workspace with.
function PersonRow({
  person: p,
  inWorkspace = false,
}: {
  person: PublicProfile
  inWorkspace?: boolean
}) {
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
      {inWorkspace && (
        <Badge variant="secondary" className="relative z-10 hidden shrink-0 sm:inline-flex">
          In your workspace
        </Badge>
      )}
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
