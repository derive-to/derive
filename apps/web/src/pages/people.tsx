import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import type { Artifact, PublicProfile } from "@/api"
import { Icon } from "@/components/icons"
import { EmptyState } from "@/components/shared/empty-state"
import { FollowButton } from "@/components/shared/follow-button"
import { PageHeader } from "@/components/shared/page-header"
import { PageShell } from "@/components/shared/page-shell"
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
import {
  followingPreviewQuery,
  followsQuery,
  peopleQuery,
  workspacePeopleQuery,
} from "@/lib/queries"
import { ago } from "@/lib/time"
import { useDelayedPending } from "@/lib/use-delayed-pending"
import { cn } from "@/lib/utils"
import { refFor } from "@/pages/artifact/parse-ref"

// The People tab — the people you work with. It folds the old Following nav item
// in: browse leads with the people you follow, then the rest of your workspace
// teammates. Search filters within those same people (the server scopes /v1/people
// to your workspaces — there is deliberately no global directory at launch);
// results stay put (dimmed) while the next set loads — never a flash.
export function People() {
  const [q, setQ] = useState("")
  const [debounced, setDebounced] = useState("")
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 220)
    return () => clearTimeout(t)
  }, [q])

  const { me } = useAuth()
  const searching = debounced.length > 0

  // Search filters within your workmates server-side; browse shows who you follow
  // + the rest of your teammates, so the query only runs while searching.
  const { data, isError, isFetching, isPlaceholderData, refetch } = useQuery({
    ...peopleQuery(debounced),
    enabled: searching,
  })
  const { data: mates = [], isPending: matesPending } = useQuery(workspacePeopleQuery())
  const { data: follows = [], isPending: followsPending } = useQuery(followsQuery())
  // Recent work from the people you follow — a small peek shown under the people grid,
  // so "who you follow" and "what they're making" live on one page. Full feed at /following.
  const { data: activity = [] } = useQuery(followingPreviewQuery())
  // Follow rows carry handle/name/avatar but not profession; follows are
  // workspace-scoped now, so the teammate roster fills in the role line.
  const professionByHandle = new Map(
    mates.map((p) => [p.username.toLowerCase(), p.profession ?? null]),
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

  // Search results: your workmates (server-scoped), minus yourself.
  const results = people.filter((p) => p.username.toLowerCase() !== me?.username?.toLowerCase())

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
        <PageHeader title="People" subtitle="The people you work with, and what they’re making." />
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
            title={searching ? `No one matches “${debounced}”.` : "It’s just you so far."}
            description={
              searching
                ? "Try a different name or @handle."
                : "Invite teammates to a workspace and they’ll show up here."
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
            <PeopleGroup label="Results" people={results} testId="people-results" />
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
              {activity.length > 0 && <ActivityPreview items={activity} />}
            </>
          )}
        </div>
      )}
    </PageShell>
  )
}

// One labelled directory section: a mono eyebrow + count over a grid of person cards.
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
  // Handles of your workspace members; cards in this set get an "In your workspace" tag.
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
      <ul
        role="list"
        data-testid={testId}
        className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3"
      >
        {people.map((p) => (
          <PersonCard
            key={p.username}
            person={p}
            inWorkspace={markWorkspace && !!mateHandles?.has(p.username.toLowerCase())}
          />
        ))}
      </ul>
    </section>
  )
}

// One person card in the grid: the identity (avatar + name/@handle/role) is a stretched
// link to the profile; a footer row carries the workspace tag + the Follow toggle as
// siblings (no interactive-inside-interactive). FollowButton self-hides for your own
// handle and signed-out viewers. `inWorkspace` tags a person you share a workspace with.
function PersonCard({
  person: p,
  inWorkspace = false,
}: {
  person: PublicProfile
  inWorkspace?: boolean
}) {
  const initials = getInitials(p.name ?? p.username)
  return (
    <li className="relative flex flex-col gap-3 rounded-xl border bg-card p-3.5 hover:border-foreground/25">
      <Link
        to="/users/$handle"
        params={{ handle: p.username }}
        data-testid={`people-card-${p.username}`}
        className="flex min-w-0 items-center gap-3 rounded-md outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
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
              profession sits below as the muted one-liner. */}
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
      {/* Footer sits above the stretched link (z-10) so the tag + Follow stay clickable. */}
      <div className="relative z-10 flex items-center gap-2">
        {inWorkspace && <Badge variant="secondary">In your workspace</Badge>}
        <FollowButton username={p.username} size="sm" className="ml-auto shrink-0" />
      </div>
    </li>
  )
}

// The "Recent activity" peek under the people grid: a few of the latest artifacts from
// the people you follow, with a link to the full feed. Keeps "who you follow" and "what
// they make" on one page without pulling in the library's heavy card + infinite grid.
function ActivityPreview({ items }: { items: Artifact[] }) {
  return (
    <section>
      <SectionEyebrow
        className="mb-3"
        count={items.length}
        action={
          <Link
            to="/following"
            data-testid="activity-view-all"
            className="font-mono text-2xs text-muted-foreground outline-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            View all
          </Link>
        }
      >
        Recent activity
      </SectionEyebrow>
      <ul
        role="list"
        data-testid="people-activity"
        className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3"
      >
        {items.map((a) => (
          <ActivityItem key={a.short_id} artifact={a} />
        ))}
      </ul>
    </section>
  )
}

// One activity card: the artifact title over a who·when meta line, linking to the artifact.
function ActivityItem({ artifact: a }: { artifact: Artifact }) {
  const updated = a.updated_at ?? a.created_at ?? a.versions?.[0]?.created_at
  const authorName = a.author?.name ?? a.author_name ?? a.author?.handle ?? a.author_login ?? null
  const authorImage = a.author?.avatar ?? a.author_avatar ?? null
  const initial = (authorName ?? a.title ?? "?").trim().charAt(0).toUpperCase()
  return (
    <li>
      <Link
        to="/artifacts/$ref"
        params={{ ref: refFor(a) }}
        data-testid={`activity-item-${a.short_id}`}
        className="flex h-full flex-col gap-2 rounded-xl border bg-card p-3.5 outline-none hover:border-foreground/25 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <span className="truncate text-sm font-medium text-foreground">
          {a.title ?? "Untitled"}
        </span>
        <span className="mt-auto flex min-w-0 items-center gap-1.5 font-mono text-2xs text-muted-foreground">
          {authorName && (
            <>
              <Avatar className="size-4 shrink-0">
                {authorImage && <AvatarImage src={authorImage} alt={authorName} />}
                <AvatarFallback
                  className="text-2xs text-scrim-foreground"
                  style={{ backgroundColor: colorForName(authorName) }}
                >
                  {initial}
                </AvatarFallback>
              </Avatar>
              <span className="truncate">{authorName}</span>
            </>
          )}
          {updated && (
            <>
              {authorName && <span aria-hidden>·</span>}
              <time dateTime={new Date(updated).toISOString()} className="shrink-0">
                {ago(updated)}
              </time>
            </>
          )}
        </span>
      </Link>
    </li>
  )
}

const PERSON_CELLS = ["a", "b", "c", "d", "e", "f"]

// One person-card placeholder: PersonCard's box model — a size-10 avatar + name/handle
// line over a profession line, then a footer with a Follow-button-sized block — minus the
// border/background (those arrive with the person → zero CLS).
function PersonSkeletonCard() {
  return (
    <li className="flex flex-col gap-3 p-3.5">
      <div className="flex items-center gap-3">
        <Skeleton className="size-10 shrink-0 rounded-full" />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3.5 w-20" />
        </div>
      </div>
      <Skeleton className="ml-auto h-8 w-24 shrink-0 rounded-lg" />
    </li>
  )
}

// The results-region first-load placeholder — the SAME grid the live results use, filled
// with person-card silhouettes. The blocks are AT-hidden (baked into Skeleton); the region
// announces via role="status" + sr-only. Shared by the in-component first load and the
// route-level PeoplePending.
export function PeopleResultsSkeleton() {
  return (
    <div role="status">
      <span className="sr-only">Loading people…</span>
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
        {PERSON_CELLS.map((k) => (
          <PersonSkeletonCard key={k} />
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
        <PageHeader title="People" subtitle="The people you work with, and what they’re making." />
        {/* The SearchField's InputGroup well is h-8, rounded-lg. */}
        <Skeleton className="h-8 w-full rounded-lg" />
      </div>
      <PeopleResultsSkeleton />
    </PageShell>
  )
}
