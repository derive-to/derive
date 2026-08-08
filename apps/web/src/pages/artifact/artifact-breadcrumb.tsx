import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate, useSearch } from "@tanstack/react-router"
import { useCallback, useEffect, useState } from "react"
import { type Artifact, api } from "@/api"
import { Icon } from "@/components/icons"
import { Breadcrumb, CrumbSep, crumbClass } from "@/components/shared/breadcrumb"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { canRenameArtifact } from "@/lib/artifact"
import { bareHotkey } from "@/lib/hotkey"
import {
  artifactQuery,
  collectionFoldersQuery,
  collectionSiblingsQuery,
  collectionsQuery,
} from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
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

/**
 * The title, and the way to change it: double-click and type.
 *
 * Renaming used to mean opening the raw source editor and republishing the whole
 * document — a version whose diff is empty, and a "new version" cue for everyone
 * reading it, because someone fixed a typo in the name. The rename endpoint is
 * metadata-only, so this is a text field and a PATCH.
 *
 * Enter commits, Escape reverts, blur commits (the same grammar as every other
 * rename in the app — collections, folders, workspaces). The field is the same
 * pixels as the heading so the line doesn't jump when it becomes editable.
 */
function EditableTitle({ art, className }: { art: Artifact; className?: string }) {
  const qc = useQueryClient()
  const shown = art.title ?? art.short_id
  const [draft, setDraft] = useState<string | null>(null)
  const rename = useApiMutation({
    mutationFn: (title: string) => api.renameArtifact(art.short_id, title),
    onSuccess: (r) => {
      // Write through rather than refetch: the header is the thing that just
      // changed, and a round trip would blink the old name back first.
      qc.setQueryData(artifactQuery(art.short_id).queryKey, (a) =>
        a ? { ...a, title: r.title } : a,
      )
    },
    // The library rows, the sibling switcher and search all carry the old name.
    invalidate: [["artifacts"], ["collections"]],
  })
  const commit = () => {
    const next = (draft ?? "").trim()
    setDraft(null)
    if (next && next !== shown) rename.mutate(next)
  }
  if (!canRenameArtifact(art))
    return (
      <span className={cn("truncate", className)} title={shown}>
        {shown}
      </span>
    )
  if (draft === null)
    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: the rename is an enhancement on the heading text; the source editor and the ⋯ menu remain keyboard-reachable paths to the same change.
      <span
        className={cn("truncate", className)}
        data-testid="artifact-title"
        title={`${shown} — double-click to rename`}
        onDoubleClick={() => setDraft(shown)}
      >
        {shown}
      </span>
    )
  return (
    <input
      // biome-ignore lint/a11y/noAutofocus: it replaced the text the user just double-clicked; anywhere else to put the caret would be wrong.
      autoFocus
      aria-label="Artifact title"
      data-testid="artifact-title-rename"
      className={cn(
        "min-w-0 flex-1 truncate rounded-sm bg-transparent outline-none ring-1 ring-border focus:ring-ring",
        className,
      )}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault()
          commit()
        } else if (e.key === "Escape") {
          e.preventDefault()
          setDraft(null)
        }
        // The page's own shortcuts (`e`, `p`, `c`, `[`/`]`) read the event target, but
        // a stray keystroke reaching a window listener from inside a rename would be
        // a surprise; keep the field's keys to the field.
        e.stopPropagation()
      }}
    />
  )
}

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
  // bareHotkey owns the "may a bare key act" guard (typing, dialogs, open menus).
  useEffect(() => {
    if (focusMode || !contextId || (!prev && !next)) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "[" && e.key !== "]") return
      if (!bareHotkey(e)) return
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
      <h1 className={cn(TITLE_CLASS, "flex min-w-0")}>
        <EditableTitle art={art} />
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
        // The title is the TITLE here too — double-click renames it, same as every
        // other view of this document. The switcher keeps its own trigger (the
        // caret), which is what it always looked like anyway; making the whole
        // heading a menu button meant the one place you'd reach to rename a
        // document was the one place you couldn't.
        <h1 className={cn(TITLE_CLASS, "flex min-w-0 flex-1 items-center gap-1")}>
          <EditableTitle art={art} />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                data-testid="artifact-sibling-switcher"
                aria-label="Switch to another artifact in this collection"
                title="Switch artifact"
                className="flex shrink-0 items-center rounded-md outline-none hover:text-foreground/70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
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
        <h1 className={cn(TITLE_CLASS, "flex min-w-0 flex-1")}>
          <EditableTitle art={art} />
        </h1>
      )}
    </Breadcrumb>
  )
}
