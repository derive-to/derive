import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useEffect, useRef, useState } from "react"
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
import { Kbd } from "@/components/ui/kbd"
import { colorForName } from "@/lib/avatar-tints"
import { fuzzyTitles } from "@/lib/fuzzy"
import { splitMatches } from "@/lib/highlight"
import { getMonogram } from "@/lib/initials"
import {
  cachedArtifactRows,
  collectionsQuery,
  workspaceSettingsQuery,
  workspacesQuery,
} from "@/lib/queries"
import { useBrandprintCollectionIds } from "@/lib/use-brandprint-ids"
import { useIsMobile } from "@/lib/use-is-mobile"
import { usePrefetchArtifact } from "@/lib/use-prefetch-artifact"
import { cn } from "@/lib/utils"
import { refFor } from "@/pages/artifact/parse-ref"
import { PaletteAsk } from "./palette-ask"
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
//
// IT ALSO ASKS. One box, both jobs, said in the placeholder — and the ask is a control pinned
// inside the INPUT (see ui/command's `action` slot), never a row in the list. A row would sit at
// one end of a ranked list competing for Enter with whatever the person actually typed a title
// for; the control cannot be scrolled past, cannot steal a keystroke, and stays in one place
// while the list underneath changes on every letter.
//
// The one exception is the case where Enter is FREE: nothing matched, so there is no document to
// open, and asking becomes the only sensible thing Enter could do. Then it IS the row.
export function CommandPalette() {
  const {
    paletteOpen,
    setPaletteOpen,
    switchWorkspace,
    openAssistant,
    pendingAsk,
    clearPendingAsk,
  } = useShell()
  const isMobile = useIsMobile()
  // The question this palette is answering, or null while it is searching. Not a boolean: the
  // text IS the mode, so there is no way to be in the answer view with nothing to answer.
  const [asking, setAsking] = useState<string | null>(null)
  // Read straight from cache (the rail already warmed these); the palette is
  // signed-in-only, so no `enabled` gate is needed.
  const { data: collections = [] } = useQuery(collectionsQuery())
  const { data: workspaces } = useQuery(workspacesQuery())
  // Chat defaults on, so an unresolved read keeps the ask offered rather than hiding a control
  // that is about to appear — the same rule the rail row follows.
  const { data: settings } = useQuery(workspaceSettingsQuery())
  const chatOn = settings ? settings.chatBeta === true : true
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
  // A question handed over by another surface, read through a ref so the effect below can key on
  // the OPEN alone. Both are set in the same batch (openAssistant), so by the time that effect
  // runs this already holds the question.
  const handed = useRef(pendingAsk)
  handed.current = pendingAsk
  // The CLEAR goes through a ref for the same reason, and it is not a nicety: it is a fresh
  // function on every render, so as a dependency it re-fired the effect below — which, by then,
  // read a consumed (null) question and dropped the answer view straight back to a search box.
  const clear = useRef(clearPendingAsk)
  clear.current = clearPendingAsk

  // ONE EFFECT OWNS WHAT AN OPEN PALETTE LOOKS LIKE, and that is not tidiness: it was two, and
  // they raced. One consumed the handed-over question into the answer view; the other reset the
  // palette to a fresh search. Same commit, so the reset won and the rail's Chat row opened a
  // search box every time.
  //
  // The results are seeded from the CACHE rather than empty: the library's cached rows are the
  // recent list, so the palette opens showing real artifacts instead of a skeleton it replaces a
  // round trip later.
  // biome-ignore lint/correctness/useExhaustiveDependencies: opening is the trigger; the handed-over question is read through a ref precisely so it cannot re-fire this and wipe the answer view.
  useEffect(() => {
    if (!paletteOpen) return
    // null = nobody handed anything over, so this is a search. A string (even an empty one) means
    // somebody asked for the agent, so open into it.
    setAsking(handed.current)
    clear.current()
    setQuery("")
    setResults(fuzzyTitles(cachedArtifactRows(qc), ""))
    setContent(EMPTY_CONTENT)
    setPeople([])
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

  // Debounced server search for artifacts by title, tag, or containing collection
  // (authoritative pass).
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

  // Ask what you just typed — in place. On a desktop this palette becomes the answer, so nothing
  // on the page behind it moves; openAssistant is still the one action, and on a phone it takes
  // the same question to /chat instead (there is no room for a conversation in a modal there).
  const askIt = (text: string) => {
    const body = text.trim()
    if (!body) return
    if (isMobile) {
      setPaletteOpen(false)
      openAssistant(body)
      return
    }
    setAsking(body)
  }

  const q = query.trim().toLowerCase()
  // An artifact whose TITLE matched already shows above — don't repeat it as a content hit;
  // the content rows are for documents found only by what's inside them.
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

  // ASKING IS OFFERED ONLY WHEN IT WOULD WORK: chat on for the workspace, and something typed to
  // ask about. Two characters is the same floor the content search uses, so the control appears
  // exactly when the list below it starts having something to say.
  const canAsk = chatOn && query.trim().length >= 2
  // Nothing to open, so Enter is free. This is what turns the ask into the row (below) and flips
  // the button's own hint from ⌘↵ to ↵ — one state, read in both places, so they cannot disagree.
  const nothingMatched =
    canAsk &&
    !loading &&
    !contentLoading &&
    !peopleLoading &&
    results.length === 0 &&
    contentOnly.length === 0 &&
    people.length === 0 &&
    matchedCollections.length === 0 &&
    otherWorkspaces.length === 0 &&
    !showAll &&
    !showFav &&
    !showFollowing &&
    !showConnect

  return (
    <CommandDialog
      open={paletteOpen}
      onOpenChange={setPaletteOpen}
      // The sr-only accessible name matches what this palette actually does.
      title="Search"
      description="Search artifacts, people, and collections."
      // ANSWERING IS A TALLER DIALOG, so it starts higher and is capped to the viewport. The
      // palette's usual `top-1/3` is right for a short result list and wrong for a transcript
      // plus a composer: measured on a 633px window, the composer sat 2px below the fold with a
      // single destination row, and 141px below it with four. A control you cannot reach is
      // worse than one that is not there.
      className={asking !== null ? "top-[6vh] max-h-[88dvh]" : undefined}
    >
      {asking !== null ? (
        <PaletteAsk
          initial={asking}
          onBack={() => setAsking(null)}
          onClose={() => setPaletteOpen(false)}
        />
      ) : (
        <Command
          shouldFilter={false}
          onKeyDown={(e) => {
            // ⌘↵ asks from ANYWHERE in the palette, including while a result row is highlighted:
            // the person has already typed the question, and making them reach for a control to
            // send it is the friction this shortcut exists to remove.
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && canAsk) {
              e.preventDefault()
              askIt(query)
            }
          }}
        >
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder="Search or ask a question…"
            action={
              canAsk ? (
                <button
                  type="button"
                  onClick={() => askIt(query)}
                  data-testid="palette-ask"
                  aria-label={`Ask Derive about ${query.trim()}`}
                  className="flex shrink-0 items-center gap-1.5 rounded-md bg-secondary px-2 py-1 text-xs text-foreground ring-1 ring-border ring-inset transition-colors hover:ring-foreground/25 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  <Icon name="sparkles" size={13} />
                  Ask
                  {/* The hint tracks what the key will ACTUALLY do: with results on screen Enter
                    belongs to the highlighted row, so asking is ⌘↵; with none it is Enter
                    itself. Two labels for one control would be worse than the truth. */}
                  <Kbd className="text-2xs">{nothingMatched ? "↵" : "⌘↵"}</Kbd>
                </button>
              ) : null
            }
          />
          <CommandList>
            <CommandEmpty>
              {loading || contentLoading || peopleLoading ? "Searching…" : "No results."}
            </CommandEmpty>

            {/* NOTHING MATCHED, so Enter has nothing to open. A question rarely matches a title
              literally, which makes this the moment asking is the better answer — and as the
              only row, it is the highlighted one, so Enter reaches it with no special rule. */}
            {nothingMatched && (
              <CommandGroup>
                <CommandItem
                  value="ask-derive"
                  data-testid="palette-ask-row"
                  onSelect={() => askIt(query)}
                >
                  <Icon name="sparkles" size={16} />
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate">Ask Derive about this</span>
                    <span className="truncate text-xs text-muted-foreground">
                      No artifact matches those words
                    </span>
                  </div>
                </CommandItem>
              </CommandGroup>
            )}

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
              // One flat list, no heading: "Artifacts" over documents and "In content" over more
              // documents was a label telling the reader which INDEX matched, which is our
              // plumbing, not their question. What tells them apart is the second line — a
              // version, or the sentence the match sits in.
              <CommandGroup className={cn(loading && "opacity-60 transition-opacity")}>
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
              <CommandGroup className={cn(contentLoading && "opacity-60 transition-opacity")}>
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
                        {getMonogram(u.name ?? u.username)}
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
          {/* What the two keys do, where a reader looks for it — and it changes with the state, so
            the footer and the Ask button always say the same thing. */}
          <div className="flex shrink-0 items-center gap-4 border-t px-3 py-2 text-2xs text-muted-foreground">
            {nothingMatched ? (
              <span>
                <Kbd className="mr-1.5 text-2xs">↵</Kbd>ask
              </span>
            ) : (
              <>
                <span>
                  <Kbd className="mr-1.5 text-2xs">↵</Kbd>open
                </span>
                {canAsk && (
                  <span>
                    <Kbd className="mr-1.5 text-2xs">⌘↵</Kbd>ask
                  </span>
                )}
              </>
            )}
            <span className="ml-auto">
              <Kbd className="mr-1.5 text-2xs">esc</Kbd>close
            </span>
          </div>
        </Command>
      )}
    </CommandDialog>
  )
}
