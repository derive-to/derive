import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { type Artifact, api, type PublicProfile, type SearchHit, workspaceDisplayName } from "@/api"
import { Icon } from "@/components/icons"
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
import { colorForName } from "@/lib/avatar-tints"
import { fuzzyTitles } from "@/lib/fuzzy"
import { splitMatches } from "@/lib/highlight"
import { getInitials } from "@/lib/initials"
import { cachedArtifactRows, collectionsQuery, workspacesQuery } from "@/lib/queries"
import { useBrandprintCollectionIds } from "@/lib/use-brandprint-ids"
import { usePrefetchArtifact } from "@/lib/use-prefetch-artifact"
import { cn } from "@/lib/utils"
import { refFor } from "@/pages/artifact/parse-ref"
import { useShell } from "./shell-context"

// The content group's data, carried together so the snippet is always highlighted
// against the query it was FETCHED for — not the live input, which races ahead of the
// (heavier, more debounced) content call and would briefly mis-highlight stale hits.
type ContentState = { hits: SearchHit[]; truncated: boolean; q: string }
const EMPTY_CONTENT: ContentState = { hits: [], truncated: false, q: "" }

// Emphasize the query where it appears in a content snippet — the surrounding text is
// muted (the caller styles it), the match reads at full weight. Splitting is pure +
// tested in lib/highlight; here we just render the marked segments. Index keys are safe:
// the segments are stateless text spans, so a shifted boundary only re-renders text.
function highlight(text: string, query: string): React.ReactNode[] {
  // Collapse the query's whitespace to match the server-collapsed snippet, so a multi-space
  // query is still located (and highlighted) in the single-spaced snippet text.
  return splitMatches(text, query.replace(/\s+/g, " ")).map((seg, i) =>
    seg.match ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: stateless text segments
      <span key={i} className="font-semibold text-foreground">
        {seg.text}
      </span>
    ) : (
      // biome-ignore lint/suspicious/noArrayIndexKey: stateless text segments
      <span key={i}>{seg.text}</span>
    ),
  )
}

// ⌘K palette: jump to any artifact (server search) or to a feed (All / Favorites /
// Following), a collection, or another workspace — from anywhere, incl. inside an artifact.
// Artifact search is async, so cmdk's built-in filtering is off and we render
// exactly the rows we want; the static rows are filtered against the query here.
export function CommandPalette() {
  const { paletteOpen, setPaletteOpen, switchWorkspace } = useShell()
  // Read straight from cache (the rail already warmed these); the palette is
  // signed-in-only, so no `enabled` gate is needed.
  const { data: collections = [] } = useQuery(collectionsQuery())
  const { data: workspaces } = useQuery(workspacesQuery())
  const nav = useNavigate()
  const prefetch = usePrefetchArtifact()
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<Artifact[]>([])
  const [content, setContent] = useState<ContentState>(EMPTY_CONTENT)
  const [people, setPeople] = useState<PublicProfile[]>([])
  const [loading, setLoading] = useState(false)
  const [contentLoading, setContentLoading] = useState(false)
  const [peopleLoading, setPeopleLoading] = useState(false)

  const qc = useQueryClient()
  // Fresh query each open — seeded from the cache, not empty: the library's cached
  // rows ARE the recent list, so the palette opens showing real artifacts instead of
  // a skeleton it replaces a round trip later.
  useEffect(() => {
    if (paletteOpen) {
      setQuery("")
      setResults(fuzzyTitles(cachedArtifactRows(qc), ""))
      setContent(EMPTY_CONTENT)
      setPeople([])
    }
  }, [paletteOpen, qc])

  // Local-first title search: every keystroke ranks the artifacts already in the
  // query cache (prefix > word prefix > substring > subsequence) and paints them
  // NOW; the debounced server search below then replaces the group with the
  // authoritative answer (it also sees artifacts the cache has never loaded).
  // The person looking for their own document by name — the common case — never
  // waits on the network at all.
  useEffect(() => {
    if (!paletteOpen) return
    setResults(fuzzyTitles(cachedArtifactRows(qc), query))
  }, [query, paletteOpen, qc])

  // Debounced server search for artifacts while open (authoritative pass).
  useEffect(() => {
    if (!paletteOpen) return
    let alive = true
    const ac = new AbortController()
    setLoading(true)
    const t = setTimeout(() => {
      api
        .listArtifacts({ q: query.trim() || undefined, limit: 8 }, { signal: ac.signal })
        .then((r) => alive && setResults(r.artifacts))
        // frontend-ignore: debounced typeahead — a failed/aborted keystroke keeps the local matches already shown, not a hidden load failure
        .catch(() => {})
        .finally(() => alive && setLoading(false))
    }, 180)
    return () => {
      alive = false
      ac.abort()
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
      setPeopleLoading(false)
      return
    }
    let alive = true
    const ac = new AbortController()
    setPeopleLoading(true)
    const t = setTimeout(() => {
      api
        .searchPeople(term, { signal: ac.signal })
        .then((r) => alive && setPeople(r.users))
        // frontend-ignore: debounced typeahead — clearing on an aborted/failed keystroke is intended, not a hidden load failure
        .catch(() => alive && setPeople([]))
        .finally(() => alive && setPeopleLoading(false))
    }, 180)
    return () => {
      alive = false
      // Abort the superseded request too — the alive flag already guarded the
      // DISPLAY race; this stops paying the authed Worker round trip for a
      // keystroke nobody will read.
      ac.abort()
      clearTimeout(t)
    }
  }, [query, paletteOpen])

  // Debounced CONTENT search (the persisted index) — finds artifacts by what's inside
  // them, not just their title, with a snippet of the match. Gated to ≥2 chars and a
  // small limit so a debounced keystroke reads only a few blobs. Slightly longer debounce
  // than the title lookup: it's the heavier call.
  useEffect(() => {
    if (!paletteOpen) return
    const term = query.trim()
    if (term.length < 2) {
      setContent(EMPTY_CONTENT)
      setContentLoading(false)
      return
    }
    let alive = true
    const ac = new AbortController()
    setContentLoading(true)
    const t = setTimeout(() => {
      api
        .searchContent(term, 6, { signal: ac.signal })
        .then((r) => alive && setContent({ hits: r.hits, truncated: r.truncated, q: term }))
        // frontend-ignore: debounced typeahead — clearing on an aborted/failed keystroke is intended, not a hidden load failure
        .catch(() => alive && setContent(EMPTY_CONTENT))
        .finally(() => alive && setContentLoading(false))
    }, 220)
    return () => {
      alive = false
      // Abort the superseded content search — it reads blobs server-side, the
      // costliest typeahead call in the palette.
      ac.abort()
      clearTimeout(t)
    }
  }, [query, paletteOpen])

  const go = (fn: () => void) => {
    setPaletteOpen(false)
    fn()
  }

  const q = query.trim().toLowerCase()
  // An artifact whose TITLE matched already shows in "Artifacts" — don't repeat it as a
  // content hit; the content group is for docs found only by what's inside them.
  const titleIds = new Set(results.map((r) => r.short_id))
  const contentOnly = content.hits.filter((h) => !titleIds.has(h.short_id))
  // Brandprint-pointed collections are managed in Settings → Brandprint, not jumped to here.
  const brandprintIds = useBrandprintCollectionIds()
  const matchedCollections = collections.filter(
    (c) => !brandprintIds.has(c.id) && c.title.toLowerCase().includes(q),
  )
  // Personal shows (and searches) under its display name, same as the user pod.
  const otherWorkspaces = (workspaces?.workspaces ?? [])
    .map((w) => ({ ...w, display: workspaceDisplayName(w) }))
    .filter((w) => w.id !== workspaces?.active && w.display.toLowerCase().includes(q))
  const showAll = "all artifacts".includes(q) || "library".includes(q)
  const showFav = "favorites".includes(q)
  const showFollowing = "following".includes(q)
  // The way back to the connect instructions after onboarding — /welcome stays the
  // app's connect-an-agent surface (see pages/welcome).
  const showConnect =
    "connect an agent".includes(q) || "getting started".includes(q) || "mcp setup".includes(q)

  return (
    <CommandDialog
      open={paletteOpen}
      onOpenChange={setPaletteOpen}
      // The sr-only accessible name matches what this palette actually does.
      title="Search"
      description="Search artifacts, people, and collections."
    >
      <Command shouldFilter={false}>
        <CommandInput
          value={query}
          onValueChange={setQuery}
          placeholder="Search artifacts, people, collections…"
        />
        <CommandList>
          <CommandEmpty>
            {loading || contentLoading || peopleLoading ? "Searching…" : "No results."}
          </CommandEmpty>

          {(showAll || showFav || showFollowing || showConnect) && (
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
                  onSelect={() => go(() => nav({ to: "/favorites" }))}
                >
                  <Icon name="favorites" size={16} /> Favorites
                </CommandItem>
              )}
              {showFollowing && (
                <CommandItem
                  value="jump-following"
                  onSelect={() => go(() => nav({ to: "/following" }))}
                >
                  <Icon name="following" size={16} /> Following
                </CommandItem>
              )}
              {showConnect && (
                <CommandItem
                  value="connect-an-agent"
                  data-testid="palette-connect-agent"
                  onSelect={() => go(() => nav({ to: "/welcome" }))}
                >
                  <Icon name="context" size={16} /> Connect an agent
                </CommandItem>
              )}
            </CommandGroup>
          )}

          {results.length > 0 && (
            // Dim while a new search is in flight — the prior matches are stale, not the answer.
            <CommandGroup
              heading="Artifacts"
              className={cn(loading && "opacity-60 transition-opacity")}
            >
              {results.map((a) => (
                <CommandItem
                  key={a.short_id}
                  value={`artifact-${a.short_id}`}
                  onSelect={() =>
                    go(() => nav({ to: "/artifacts/$ref", params: { ref: refFor(a) } }))
                  }
                  onMouseEnter={() => prefetch(a.short_id)}
                  onFocus={() => prefetch(a.short_id)}
                >
                  <Icon name="all" size={16} className="text-muted-foreground" />
                  <span className="flex-1 truncate">{a.title ?? a.short_id}</span>
                  <span className="font-mono text-2xs text-muted-foreground tabular-nums">
                    v{a.current_version}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}

          {contentOnly.length > 0 && (
            <CommandGroup
              heading="In content"
              className={cn(contentLoading && "opacity-60 transition-opacity")}
            >
              {contentOnly.map((h) => (
                <CommandItem
                  key={`content-${h.short_id}`}
                  value={`content-${h.short_id}`}
                  onSelect={() =>
                    go(() => nav({ to: "/artifacts/$ref", params: { ref: refFor(h) } }))
                  }
                  onMouseEnter={() => prefetch(h.short_id)}
                  onFocus={() => prefetch(h.short_id)}
                  // Top-align: this is a two-line row (title over snippet), so the icon
                  // sits with the title, not centered against the whole block. Keeping the
                  // item flex-ROW (a flex-col child holds the two lines) leaves cmdk's
                  // trailing check glyph in the row instead of adding a phantom third line.
                  className="items-start"
                >
                  <Icon name="all" size={16} className="mt-0.5 text-muted-foreground" />
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate">{h.title}</span>
                    {h.snippet && (
                      <span className="truncate text-xs text-muted-foreground">
                        {highlight(h.snippet, content.q)}
                      </span>
                    )}
                  </div>
                </CommandItem>
              ))}
              {/* Escape the 6-row peek: jump to the full, browsable results page. */}
              <CommandItem
                value="see-all-results"
                data-testid="palette-see-all-results"
                onSelect={() => go(() => nav({ to: "/search", search: { q: query.trim() } }))}
                className="text-muted-foreground"
              >
                <Icon name="search" size={16} />
                <span>
                  {content.truncated ? "See all results (more match)" : "See all results"}
                </span>
              </CommandItem>
            </CommandGroup>
          )}

          {people.length > 0 && (
            <CommandGroup
              heading="People"
              className={cn(peopleLoading && "opacity-60 transition-opacity")}
            >
              {people.map((u) => (
                <CommandItem
                  key={u.username}
                  value={`person-${u.username}`}
                  onSelect={() =>
                    go(() => nav({ to: "/users/$handle", params: { handle: u.username } }))
                  }
                >
                  <Avatar className="size-5">
                    {u.image && <AvatarImage src={u.image} alt={u.name ?? u.username} />}
                    {/* Identity tint — the house idiom for people (cf. author-chip,
                        people.tsx); one glyph at this micro scale. */}
                    <AvatarFallback
                      className="text-2xs font-medium text-scrim-foreground"
                      style={{ backgroundColor: colorForName(u.name ?? u.username) }}
                    >
                      {getInitials(u.name ?? u.username).charAt(0)}
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
                  <span className="font-mono text-2xs text-muted-foreground tabular-nums">
                    {c.count}
                  </span>
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
                  <span className="flex-1 truncate">{w.display}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </CommandList>
      </Command>
    </CommandDialog>
  )
}
