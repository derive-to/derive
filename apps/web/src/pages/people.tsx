import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useEffect, useRef, useState } from "react"
import { api } from "@/api"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Input } from "@/components/ui/input"

// Find people: search opted-in accounts by @handle or name and open their public
// profile. Only users who turned on discoverability appear (server-enforced).
export function People() {
  const [q, setQ] = useState("")
  const [debounced, setDebounced] = useState("")
  const input = useRef<HTMLInputElement>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only focus.
  useEffect(() => input.current?.focus(), [])
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250)
    return () => clearTimeout(t)
  }, [q])

  const { data, isFetching } = useQuery({
    queryKey: ["people", debounced],
    queryFn: () => api.searchPeople(debounced).then((r) => r.users),
    enabled: debounced.length > 0,
  })
  const users = debounced ? (data ?? []) : []

  return (
    <div className="mx-auto w-full max-w-xl p-6 sm:p-10">
      <h1 className="mb-1 font-display text-2xl font-semibold text-foreground">Find people</h1>
      <p className="mb-4 text-sm text-muted-foreground">
        Search people by username or name. Only those who've made themselves discoverable appear.
      </p>
      <Input
        ref={input}
        data-testid="people-search"
        value={q}
        autoCapitalize="none"
        autoCorrect="off"
        onChange={(e) => setQ(e.target.value)}
        placeholder="@username or name"
        aria-label="Search people"
      />
      <div className="mt-4 flex flex-col gap-1">
        {debounced && users.length === 0 && !isFetching && (
          <p className="px-2 text-sm text-muted-foreground" data-testid="people-empty">
            No one found for "{debounced}".
          </p>
        )}
        {users.map((u) => (
          <Link
            key={u.username}
            to="/u/$handle"
            params={{ handle: u.username }}
            data-testid="people-result"
            className="flex items-center gap-3 rounded-lg p-2 transition-colors hover:bg-hover"
          >
            <Avatar className="size-9">
              {u.image && <AvatarImage src={u.image} alt={u.name ?? u.username} />}
              <AvatarFallback>{(u.name ?? u.username).slice(0, 2).toUpperCase()}</AvatarFallback>
            </Avatar>
            <span className="min-w-0">
              {u.name && (
                <span className="block truncate text-sm font-semibold text-foreground">
                  {u.name}
                </span>
              )}
              <span className="block truncate text-xs text-muted-foreground">@{u.username}</span>
            </span>
          </Link>
        ))}
      </div>
    </div>
  )
}
