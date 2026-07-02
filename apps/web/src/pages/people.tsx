import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { api, type PublicProfile } from "@/api"
import { FollowButton } from "@/components/follow-button"
import { EmptyState } from "@/components/shared/empty-state"
import { Spinner } from "@/components/shared/spinner"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Input } from "@/components/ui/input"
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

  const { data, isPending, isError } = useQuery({
    queryKey: ["people", debounced],
    queryFn: () => api.people(debounced || undefined).then((r) => r.users),
    placeholderData: keepPreviousData,
  })
  const people = data ?? []

  return (
    <div className="mx-auto w-full max-w-3xl p-6 sm:p-8">
      <h1 className="text-2xl font-semibold text-foreground">People</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Find people on Derive and follow their work.
      </p>
      <Input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search people by name or @handle…"
        aria-label="Search people"
        data-testid="people-search"
        className="mt-4"
      />

      <div className="mt-5">
        {isPending ? (
          <div className="py-10">
            <Spinner />
          </div>
        ) : isError ? (
          <EmptyState>Couldn't load people right now.</EmptyState>
        ) : people.length === 0 ? (
          <div data-testid="people-empty">
            <EmptyState>
              {debounced
                ? `No people match "${debounced}".`
                : "No discoverable people yet. People who turn on discoverability show up here."}
            </EmptyState>
          </div>
        ) : (
          <ul
            className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3"
            data-testid="people-grid"
          >
            {people.map((p) => (
              <PersonCard key={p.username} person={p} />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

// One directory row: identity links to the profile; Follow sits beside it (a sibling,
// not nested in the link — no interactive-inside-interactive). FollowButton self-hides
// for your own handle and signed-out viewers.
function PersonCard({ person: p }: { person: PublicProfile }) {
  const initials = getInitials(p.name ?? p.username)
  return (
    <li className="flex items-center gap-3 rounded-lg border border-border bg-card p-3 transition-colors hover:border-primary">
      <Link
        to="/u/$handle"
        params={{ handle: p.username }}
        data-testid={`people-card-${p.username}`}
        className="flex min-w-0 flex-1 items-center gap-3 outline-none"
      >
        <Avatar className="size-9 shrink-0">
          {p.image && <AvatarImage src={p.image} alt={p.name ?? p.username} />}
          <AvatarFallback>{initials}</AvatarFallback>
        </Avatar>
        <span className="min-w-0">
          {p.name && (
            <span className="block truncate text-sm font-medium text-foreground">{p.name}</span>
          )}
          <span className="block truncate font-mono text-xs text-muted-foreground">
            @{p.username}
          </span>
          {p.profession && (
            <span className="block truncate text-2xs text-accent-foreground">{p.profession}</span>
          )}
        </span>
      </Link>
      <FollowButton username={p.username} size="xs" className="shrink-0" />
    </li>
  )
}
