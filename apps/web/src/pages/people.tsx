import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { api, type PublicProfile } from "@/api"
import { FollowButton } from "@/components/follow-button"
import { Icon } from "@/components/icons"
import { EmptyState } from "@/components/shared/empty-state"
import { PageHeader } from "@/components/shared/page-header"
import { PageShell } from "@/components/shared/page-shell"
import { SearchField } from "@/components/shared/search-field"
import { Spinner } from "@/components/shared/spinner"
import { StatusPanel } from "@/components/shared/status-panel"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { colorForName } from "@/lib/avatar-tints"
import { getInitials } from "@/lib/initials"

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

  const { data, isPending, isError, isFetching, refetch } = useQuery({
    queryKey: ["people", debounced],
    queryFn: () => api.people(debounced || undefined).then((r) => r.users),
    placeholderData: keepPreviousData,
  })
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
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
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
          // Deliberately 240px min, not CardGrid's 220px — a person row (identity + Follow) is wider than an artifact card.
          <ul
            role="list"
            className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3"
            data-testid="people-grid"
          >
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
