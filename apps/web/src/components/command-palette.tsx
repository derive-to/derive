import { useNavigate } from "@tanstack/react-router"
import { useCallback, useEffect, useState } from "react"
import { type Artifact, api, type PublicProfile } from "@/api"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { usePrefetchArtifact } from "@/lib/use-prefetch-artifact"
import { Icon } from "./icons"
import { useShell } from "./shell-context"

// ⌘K palette: jump to any artifact (server search) or to a view (All / Favorites),
// a collection, or another workspace — from anywhere, including inside an artifact.
// Artifact search is async, so cmdk's built-in filtering is off and we render
// exactly the rows we want; the static rows are filtered against the query here.
export function CommandPalette() {
  const { paletteOpen, setPaletteOpen, collections, workspaces, switchWorkspace } = useShell()
  const nav = useNavigate()
  const prefetch = usePrefetchArtifact()
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<Artifact[]>([])
  const [people, setPeople] = useState<PublicProfile[]>([])
  const [loading, setLoading] = useState(false)

  // Fresh query each open.
  useEffect(() => {
    if (paletteOpen) {
      setQuery("")
      setPeople([])
    }
  }, [paletteOpen])

  // Debounced server search for artifacts while open.
  useEffect(() => {
    if (!paletteOpen) return
    let alive = true
    setLoading(true)
    const t = setTimeout(() => {
      api
        .listArtifacts({ q: query.trim() || undefined, limit: 8 })
        .then((r) => alive && setResults(r.artifacts))
        .catch(() => alive && setResults([]))
        .finally(() => alive && setLoading(false))
    }, 180)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [query, paletteOpen])

  // Debounced people search (discoverable accounts) — only with a query, so an
  // empty palette never enumerates people.
  useEffect(() => {
    if (!paletteOpen) return
    const term = query.trim()
    if (!term) {
      setPeople([])
      return
    }
    let alive = true
    const t = setTimeout(() => {
      api
        .searchPeople(term)
        .then((r) => alive && setPeople(r.users))
        .catch(() => alive && setPeople([]))
    }, 180)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [query, paletteOpen])

  const go = useCallback(
    (fn: () => void) => {
      setPaletteOpen(false)
      fn()
    },
    [setPaletteOpen],
  )

  const q = query.trim().toLowerCase()
  const matchedCollections = collections.filter((c) => c.title.toLowerCase().includes(q))
  const otherWorkspaces = workspaces?.multi
    ? workspaces.workspaces.filter(
        (w) => w.id !== workspaces.active && w.name.toLowerCase().includes(q),
      )
    : []
  const showAll = "all artifacts".includes(q) || "library".includes(q)
  const showFav = "favorites".includes(q)

  return (
    <CommandDialog open={paletteOpen} onOpenChange={setPaletteOpen}>
      <Command shouldFilter={false}>
        <CommandInput
          value={query}
          onValueChange={setQuery}
          placeholder="Search artifacts, people, collections…"
        />
        <CommandList>
          <CommandEmpty>{loading ? "Searching…" : "No results."}</CommandEmpty>

          {(showAll || showFav) && (
            <CommandGroup heading="Jump to">
              {showAll && (
                <CommandItem
                  value="jump-all"
                  onSelect={() => go(() => nav({ to: "/", search: {} }))}
                >
                  <Icon name="all" size={16} /> All artifacts
                </CommandItem>
              )}
              {showFav && (
                <CommandItem
                  value="jump-favorites"
                  onSelect={() => go(() => nav({ to: "/", search: { f: "favorites" } }))}
                >
                  <Icon name="favorites" size={16} /> Favorites
                </CommandItem>
              )}
            </CommandGroup>
          )}

          {results.length > 0 && (
            <CommandGroup heading="Artifacts">
              {results.map((a) => (
                <CommandItem
                  key={a.short_id}
                  value={`artifact-${a.short_id}`}
                  onSelect={() => go(() => nav({ to: "/a/$ref", params: { ref: a.short_id } }))}
                  onMouseEnter={() => prefetch(a.short_id, a.current_version)}
                  onFocus={() => prefetch(a.short_id, a.current_version)}
                >
                  <Icon name="all" size={16} className="text-muted-foreground" />
                  <span className="flex-1 truncate">{a.title ?? a.short_id}</span>
                  <span className="font-mono text-2xs text-muted-foreground">
                    v{a.current_version}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}

          {people.length > 0 && (
            <CommandGroup heading="People">
              {people.map((u) => (
                <CommandItem
                  key={u.username}
                  value={`person-${u.username}`}
                  onSelect={() =>
                    go(() => nav({ to: "/u/$handle", params: { handle: u.username } }))
                  }
                >
                  <Avatar className="size-5">
                    {u.image && <AvatarImage src={u.image} alt={u.name ?? u.username} />}
                    <AvatarFallback>
                      {(u.name ?? u.username).slice(0, 2).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <span className="flex-1 truncate">{u.name ?? u.username}</span>
                  <span className="font-mono text-2xs text-muted-foreground">@{u.username}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}

          {matchedCollections.length > 0 && (
            <CommandGroup heading="Collections">
              {matchedCollections.map((c) => (
                <CommandItem
                  key={c.id}
                  value={`collection-${c.id}`}
                  onSelect={() => go(() => nav({ to: "/", search: { collection: c.id } }))}
                >
                  <Icon name="collection" size={16} />
                  <span className="flex-1 truncate">{c.title}</span>
                  <span className="font-mono text-2xs text-muted-foreground">{c.count}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}

          {otherWorkspaces.length > 0 && (
            <CommandGroup heading="Switch workspace">
              {otherWorkspaces.map((w) => (
                <CommandItem
                  key={w.id}
                  value={`workspace-${w.id}`}
                  onSelect={() => go(() => switchWorkspace(w.id))}
                >
                  <Icon name="workspace" size={16} />
                  <span className="flex-1 truncate">{w.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </CommandList>
      </Command>
    </CommandDialog>
  )
}
