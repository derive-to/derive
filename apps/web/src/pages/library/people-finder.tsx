import { useQuery } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { api } from "@/api"
import { Icon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useFollows } from "@/lib/use-follows"

// "Find people to follow": the discovery surface the Following view was missing.
// Searches the workspace's discoverable people (GET /v1/users/search) and follows a
// person by their @handle — which then surfaces their work (hand-published or synced)
// in the feed. Without this the Following view is a dead end: nothing to follow from.
export function PeopleFinder() {
  const [q, setQ] = useState("")
  const [debounced, setDebounced] = useState("")
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250)
    return () => clearTimeout(t)
  }, [q])

  const { data, isFetching } = useQuery({
    queryKey: ["people-search", debounced] as const,
    queryFn: () => api.searchPeople(debounced).then((r) => r.users),
    enabled: debounced.length > 0,
  })
  const { isFollowingUser, toggleUser } = useFollows()
  const people = debounced ? (data ?? []) : []

  return (
    <section className="mb-5" data-testid="people-finder">
      <Input
        placeholder="Find people to follow…"
        aria-label="Find people to follow"
        data-testid="people-finder-search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        className="mb-2.5"
      />
      {debounced && !isFetching && people.length === 0 && (
        <p className="px-1 text-sm text-muted-foreground">
          No one found for “{debounced}”. People are findable once they make their profile
          discoverable.
        </p>
      )}
      {people.length > 0 && (
        <ul className="flex flex-col gap-1.5" data-testid="people-finder-results">
          {people.map((p) => {
            const following = isFollowingUser(p.username)
            return (
              <li
                key={p.username}
                className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2"
              >
                {p.image ? (
                  <img src={p.image} alt="" className="size-8 shrink-0 rounded-full object-cover" />
                ) : (
                  <div className="grid size-8 shrink-0 place-items-center rounded-full bg-secondary text-2xs font-semibold text-muted-foreground">
                    {(p.name ?? p.username).slice(0, 2).toUpperCase()}
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-foreground">
                    {p.name ?? `@${p.username}`}
                  </div>
                  <div className="truncate font-mono text-2xs text-muted-foreground">
                    @{p.username}
                    {p.profession ? ` · ${p.profession}` : ""}
                  </div>
                </div>
                <Button
                  variant={following ? "secondary" : "primary"}
                  size="sm"
                  data-testid={`people-finder-follow-${p.username}`}
                  aria-pressed={following}
                  title={following ? `Unfollow @${p.username}` : `Follow @${p.username}`}
                  onClick={() => toggleUser(p.username)}
                >
                  {following ? (
                    <>
                      <Icon name="check" size={15} /> Following
                    </>
                  ) : (
                    <>
                      <Icon name="following" size={15} /> Follow
                    </>
                  )}
                </Button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
