import { useQuery } from "@tanstack/react-query"
import { Link, useNavigate, useSearch } from "@tanstack/react-router"
import { useCallback, useEffect } from "react"
import type { Artifact } from "@/api"
import { Icon } from "@/components/icons"
import { Breadcrumb, CrumbSep, crumbClass } from "@/components/shared/breadcrumb"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Kbd } from "@/components/ui/kbd"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { collectionFoldersQuery, collectionSiblingsQuery, collectionsQuery } from "@/lib/queries"
import { cn } from "@/lib/utils"
import { folderScopedSiblingIds, resolveContextCollection, siblingNav } from "./lib/siblings"
import { refFor } from "./parse-ref"

// Shared title styling so the plain-title and switcher-trigger forms are pixel-identical
// (the reframe's document header: serif, base, tight).
// vt-doc-title (globals.css): the receiving half of the card->workbench title morph —
// the clicked card's title claims the same view-transition name just-in-time, so
// opening a document MOVES its title into this header instead of cutting.
const TITLE_CLASS =
  "vt-doc-title truncate font-serif text-base font-medium leading-tight tracking-tight"

// The document-title line in the artifact header. When the artifact was opened from a
// collection (the `?collection=` context) — or belongs to exactly one — the title
// becomes a breadcrumb: `Collection / Title`, where the collection links to its home and
// the title is a switcher that pages between sibling artifacts in that collection.
// `[` / `]` do the same from the keyboard. With no such context it's just the title,
// exactly as before. The title is always the page's <h1>, in every branch. Hidden in
// focus mode by the header wrapper (it stays mounted; keyboard paging is gated off then).
export function ArtifactBreadcrumb({ art, focusMode }: { art: Artifact; focusMode: boolean }) {
  const nav = useNavigate()
  const { collection: paramCollection } = useSearch({ from: "/artifacts/$ref" })
  const { data: collections = [] } = useQuery(collectionsQuery())
  const contextId = resolveContextCollection(paramCollection, art.collections)
  const { data: siblings = [] } = useQuery({
    ...collectionSiblingsQuery(contextId ?? ""),
    enabled: !!contextId,
  })
  const { data: folderData, isPending: folderPending } = useQuery({
    ...collectionFoldersQuery(contextId ?? ""),
    enabled: !!contextId,
  })
  const collectionTitle = contextId ? collections.find((c) => c.id === contextId)?.title : undefined

  // Folder context: which folder (if any) this artifact sits in FOR the context
  // collection, so the breadcrumb reads `Collection / Folder / Title` and the switcher
  // pages within that folder — the set the breadcrumb says you're in.
  const assignments = folderData?.assignments ?? {}
  const currentFolderId = assignments[art.short_id]
  const folderName = currentFolderId
    ? folderData?.folders.find((f) => f.id === currentFolderId)?.name
    : undefined
  const scopedIds = folderScopedSiblingIds(
    siblings.map((s) => s.short_id),
    assignments,
    art.short_id,
  )
  const scopedSiblings = siblings.filter((s) => scopedIds.includes(s.short_id))

  const { index, total, prev, next } = siblingNav(scopedIds, art.short_id)

  const goto = useCallback(
    (target: string | null) => {
      if (!target) return
      const sib = siblings.find((s) => s.short_id === target)
      if (!sib) return
      nav({
        to: "/artifacts/$ref",
        params: { ref: refFor(sib) },
        // Carry the context forward so the switcher persists across the jump.
        search: contextId ? { collection: contextId } : {},
      })
    },
    [siblings, nav, contextId],
  )

  // `[` / `]` page prev/next — free keys (arrows are taken for slide decks). Off in focus
  // mode (the header is hidden — silent paging would eject you from a presented deck).
  // Ignore while typing or with a dialog / menu / listbox open, and don't fight modified
  // chords.
  useEffect(() => {
    if (focusMode || !contextId || (!prev && !next)) return
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key !== "[" && e.key !== "]") return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return
      if (document.querySelector('[role="dialog"],[role="menu"],[role="listbox"]')) return
      e.preventDefault()
      goto(e.key === "[" ? prev : next)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [focusMode, contextId, prev, next, goto])

  // No resolvable collection context (0 or ambiguously-many memberships, or its title
  // isn't in reach) → the title alone, unchanged.
  if (!contextId || !collectionTitle) {
    return (
      <h1 className={TITLE_CLASS} title={art.title ?? art.short_id}>
        {art.title ?? art.short_id}
      </h1>
    )
  }

  // Hold the switcher until the folders query has SETTLED (loaded or errored): siblings and
  // folders load independently, and showing a collection-wide switcher (e.g. "5 / 30") that
  // then snaps to folder scope ("2 / 4") — or vanishes when the folder holds one doc — is a
  // visible morph, so the title renders plain until then. Gating on "settled" (not "data
  // present") means a folders-endpoint error resolves to a collection-wide switcher rather
  // than none — core navigation never depends on that secondary query succeeding.
  const hasSwitcher = index >= 0 && total > 1 && !folderPending

  return (
    <Breadcrumb>
      <Link
        to="/"
        search={{ collection: contextId }}
        data-testid="breadcrumb-collection"
        className={cn("text-sm", crumbClass())}
        title={`Open ${collectionTitle}`}
      >
        {collectionTitle}
      </Link>
      <CrumbSep />
      {folderName && currentFolderId && (
        // The folder segment — present only when the artifact is filed. Links back to the
        // collection home scrolled to that folder (the `?folder=` anchor).
        <>
          <Link
            to="/"
            search={{ collection: contextId, folder: currentFolderId }}
            data-testid="breadcrumb-folder"
            // The MIDDLE crumb yields first under width pressure so the document title —
            // the leaf, the <h1> — keeps priority.
            className={cn("text-sm", crumbClass(true))}
            title={`Open folder ${folderName}`}
          >
            {folderName}
          </Link>
          <CrumbSep />
        </>
      )}
      {hasSwitcher ? (
        // The title stays the page's <h1>; the switcher control lives inside it. `flex-1`
        // gives the title the remaining space (crumbs shrink around it).
        <h1 className="flex min-w-0 flex-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                data-testid="artifact-sibling-switcher"
                title={art.title ?? art.short_id}
                className={cn(
                  TITLE_CLASS,
                  "flex min-w-0 items-center gap-1 rounded-md text-left outline-none hover:text-foreground/70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                )}
              >
                <span className="truncate">{art.title ?? art.short_id}</span>
                <Icon name="caret" size={16} className="shrink-0 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-80 w-72 overflow-auto">
              {scopedSiblings.map((s) => (
                <DropdownMenuItem
                  key={s.short_id}
                  data-testid={`sibling-option-${s.short_id}`}
                  onSelect={() => goto(s.short_id)}
                  className="gap-2"
                >
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate",
                      s.short_id === art.short_id && "font-medium",
                    )}
                  >
                    {s.title ?? s.short_id}
                  </span>
                  {s.short_id === art.short_id && (
                    <Icon name="check" size={16} className="shrink-0 text-muted-foreground" />
                  )}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </h1>
      ) : (
        <h1 className={cn(TITLE_CLASS, "min-w-0 flex-1")} title={art.title ?? art.short_id}>
          {art.title ?? art.short_id}
        </h1>
      )}
      {hasSwitcher && (
        <div className="flex shrink-0 items-center gap-0.5 pl-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Previous artifact in collection"
                data-testid="sibling-prev"
                disabled={!prev}
                onClick={() => goto(prev)}
              >
                <Icon name="chevron-left" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              Previous <Kbd>[</Kbd>
            </TooltipContent>
          </Tooltip>
          <span
            // The scope is otherwise invisible: the denominator is the FOLDER count when
            // filed, the whole-collection count when not. The tooltip names it so the
            // number never looks like it jumped for no reason.
            title={
              folderName
                ? `${index + 1} of ${total} in ${folderName}`
                : `${index + 1} of ${total} in the collection`
            }
            className="px-0.5 font-mono text-2xs tabular-nums text-muted-foreground"
          >
            {index + 1} / {total}
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Next artifact in collection"
                data-testid="sibling-next"
                disabled={!next}
                onClick={() => goto(next)}
              >
                <Icon name="chevron-right" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              Next <Kbd>]</Kbd>
            </TooltipContent>
          </Tooltip>
        </div>
      )}
    </Breadcrumb>
  )
}
