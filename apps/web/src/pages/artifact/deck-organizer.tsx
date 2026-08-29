import {
  ArrowDown,
  ArrowUp,
  Copy,
  GripVertical,
  MoreHorizontal,
  Plus,
  RotateCcw,
  Trash2,
} from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { type Artifact, api } from "@/api"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { SectionTitle } from "@/components/shared/section-title"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { useApiMutation } from "@/lib/use-api-mutation"
import { cn } from "@/lib/utils"
import type { Deck } from "./types"

export type ServerSlideOp =
  | { op: "move"; from: number; to: number }
  | { op: "delete"; at: number }
  | { op: "duplicate"; at: number }
  | { op: "insert"; at: number }

export type OrganizerSlide = {
  key: string
  label: string
  kind: "base" | "duplicate" | "insert"
  sourceKey?: string
  created: number
  restoreAt?: number
  restoreBeforeKey?: string
  restoreAfterKey?: string
}

type Snapshot = { slides: OrganizerSlide[]; trash: OrganizerSlide[]; selectedKey: string | null }

const baseSlides = (deck: Deck | null): OrganizerSlide[] =>
  Array.from({ length: Math.min(500, deck?.slides.length || deck?.total || 0) }, (_, i) => ({
    key: `base:${deck?.slides[i]?.id ?? i}`,
    label: deck?.slides[i]?.label || `Untitled slide ${i + 1}`,
    kind: "base",
    created: i,
  }))

/** Compile the visible local model into position-based server intent. New slides are
 *  materialized first, removals second, then the surviving slides are put in order. This
 *  makes restoring any item from the session Trash free: Trash changes local state, while
 *  Save still produces one atomic batch against the version the session opened on. */
export function compileSlideOps(
  initial: OrganizerSlide[],
  slides: OrganizerSlide[],
  trash: OrganizerSlide[],
): ServerSlideOp[] {
  const ops: ServerSlideOp[] = []
  const current = initial.map((slide) => slide.key)
  const wanted = new Set(slides.map((slide) => slide.key))
  const all = new Map([...slides, ...trash].map((slide) => [slide.key, slide]))

  const ensure = (key: string) => {
    if (current.includes(key)) return
    const slide = all.get(key)
    if (!slide) throw new Error("A slide in this arrangement can no longer be found.")
    if (slide.kind === "insert") {
      ops.push({ op: "insert", at: current.length + 1 })
      current.push(key)
      return
    }
    if (slide.kind === "duplicate" && slide.sourceKey) {
      ensure(slide.sourceKey)
      const sourceAt = current.indexOf(slide.sourceKey)
      ops.push({ op: "duplicate", at: sourceAt + 1 })
      current.splice(sourceAt + 1, 0, key)
      return
    }
    throw new Error("A copied slide lost its source.")
  }

  for (const slide of [...slides].sort((a, b) => a.created - b.created)) ensure(slide.key)
  for (let i = current.length - 1; i >= 0; i--)
    if (!wanted.has(current[i] as string)) {
      ops.push({ op: "delete", at: i + 1 })
      current.splice(i, 1)
    }
  for (let to = 0; to < slides.length; to++) {
    const key = (slides[to] as OrganizerSlide).key
    const from = current.indexOf(key)
    if (from === to) continue
    ops.push({ op: "move", from: from + 1, to: to + 1 })
    const [moved] = current.splice(from, 1)
    if (moved) current.splice(to, 0, moved)
  }
  return ops
}

export function restoreSlideIndex(slide: OrganizerSlide, slides: OrganizerSlide[]): number {
  const beforeAt = slide.restoreBeforeKey
    ? slides.findIndex((candidate) => candidate.key === slide.restoreBeforeKey)
    : -1
  const afterAt = slide.restoreAfterKey
    ? slides.findIndex((candidate) => candidate.key === slide.restoreAfterKey)
    : -1
  return beforeAt >= 0
    ? beforeAt
    : afterAt >= 0
      ? afterAt + 1
      : Math.min(slide.restoreAt ?? slides.length, slides.length)
}

export function useDeckOrganizer(p: {
  shortId: string
  art: Artifact | undefined
  deck: Deck | null
  onSaved: () => void
  onGoTo: (i: number) => void
}) {
  const [open, setOpen] = useState(false)
  const [initialSlides, setInitialSlides] = useState<OrganizerSlide[]>([])
  const [sessionBaseVersion, setSessionBaseVersion] = useState<number | null>(null)
  const [slides, setSlides] = useState<OrganizerSlide[]>([])
  const [trash, setTrash] = useState<OrganizerSlide[]>([])
  const [history, setHistory] = useState<Snapshot[]>([])
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [exitPrompt, setExitPrompt] = useState(false)
  const [announcement, setAnnouncement] = useState("")
  const serial = useRef(0)
  const pendingOps = useMemo(
    () => compileSlideOps(initialSlides, slides, trash),
    [initialSlides, slides, trash],
  )

  const reset = (shouldOpen: boolean) => {
    const fresh = baseSlides(p.deck)
    const selected = fresh[p.deck?.i ?? 0]?.key ?? fresh[0]?.key ?? null
    setInitialSlides(fresh)
    setSessionBaseVersion(p.art?.current_version ?? null)
    setSlides(fresh)
    setTrash([])
    setHistory([])
    setSelectedKey(selected)
    setAnnouncement("")
    setExitPrompt(false)
    setOpen(shouldOpen)
  }

  // A live refetch may update labels while the organizer is closed. Never replace a dirty
  // local arrangement underneath the person who is still deciding whether to save it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resync is deliberately keyed to server outline changes while closed; reset is an event helper.
  useEffect(() => {
    if (!open) reset(false)
  }, [p.deck?.total, p.deck?.slides, p.shortId])

  const commit = (next: Omit<Snapshot, "selectedKey"> & { selectedKey?: string | null }) => {
    setHistory((old) => [...old, { slides, trash, selectedKey }])
    setSlides(next.slides)
    setTrash(next.trash)
    if (next.selectedKey !== undefined) setSelectedKey(next.selectedKey)
  }

  const select = (key: string) => {
    const slide = slides.find((candidate) => candidate.key === key)
    if (!slide) return
    setSelectedKey(key)
    if (slide.kind === "base") {
      const sourceAt = initialSlides.findIndex((candidate) => candidate.key === key)
      if (sourceAt >= 0) p.onGoTo(sourceAt)
    }
  }
  const move = (from: number, to: number) => {
    if (from === to || from < 0 || to < 0 || from >= slides.length || to >= slides.length) return
    const next = [...slides]
    const [moved] = next.splice(from, 1)
    if (!moved) return
    next.splice(to, 0, moved)
    commit({ slides: next, trash, selectedKey: moved.key })
    if (moved.kind === "base") {
      const sourceAt = initialSlides.findIndex((candidate) => candidate.key === moved.key)
      if (sourceAt >= 0) p.onGoTo(sourceAt)
    }
    setAnnouncement(`${moved.label} moved to slide ${to + 1}.`)
  }
  const add = () => {
    const at =
      Math.max(
        0,
        slides.findIndex((slide) => slide.key === selectedKey),
      ) + 1
    const created = Date.now() + serial.current++
    const slide: OrganizerSlide = {
      key: `insert:${created}`,
      label: "New slide",
      kind: "insert",
      created,
    }
    const next = [...slides]
    next.splice(at, 0, slide)
    commit({ slides: next, trash, selectedKey: slide.key })
    setAnnouncement(`New slide added at position ${at + 1}.`)
  }
  const duplicate = (key: string) => {
    const at = slides.findIndex((slide) => slide.key === key)
    if (at < 0) return
    const created = Date.now() + serial.current++
    const source = slides[at] as OrganizerSlide
    const slide: OrganizerSlide = {
      key: `copy:${created}`,
      label: `${source.label} copy`,
      kind: "duplicate",
      sourceKey: source.key,
      created,
    }
    const next = [...slides]
    next.splice(at + 1, 0, slide)
    commit({ slides: next, trash, selectedKey: slide.key })
    setAnnouncement(`${source.label} duplicated at position ${at + 2}.`)
  }
  const remove = (key: string) => {
    if (slides.length <= 1) return
    const at = slides.findIndex((slide) => slide.key === key)
    if (at < 0) return
    const slide = {
      ...(slides[at] as OrganizerSlide),
      restoreAt: at,
      restoreAfterKey: slides[at - 1]?.key,
      restoreBeforeKey: slides[at + 1]?.key,
    }
    const next = slides.filter((candidate) => candidate.key !== key)
    const nextSelected =
      selectedKey === key
        ? ((next[Math.min(at, next.length - 1)] as OrganizerSlide | undefined)?.key ?? null)
        : selectedKey
    commit({ slides: next, trash: [slide, ...trash], selectedKey: nextSelected })
    if (nextSelected) select(nextSelected)
    setAnnouncement(`${slide.label} moved to Trash.`)
  }
  const restoreFromTrash = (key: string) => {
    const slide = trash.find((candidate) => candidate.key === key)
    if (!slide) return
    const at = restoreSlideIndex(slide, slides)
    const next = [...slides]
    next.splice(at, 0, {
      ...slide,
      restoreAt: undefined,
      restoreBeforeKey: undefined,
      restoreAfterKey: undefined,
    })
    commit({
      slides: next,
      trash: trash.filter((candidate) => candidate.key !== key),
      selectedKey: slide.key,
    })
    if (slide.kind === "base") {
      const sourceAt = initialSlides.findIndex((candidate) => candidate.key === slide.key)
      if (sourceAt >= 0) p.onGoTo(sourceAt)
    }
    setAnnouncement(`${slide.label} restored to slide ${at + 1}.`)
  }
  const undo = () => {
    const previous = history.at(-1)
    if (!previous) return
    setSlides(previous.slides)
    setTrash(previous.trash)
    setSelectedKey(previous.selectedKey)
    setHistory((old) => old.slice(0, -1))
    setAnnouncement("Last slide change undone.")
  }
  const requestClose = () => {
    if (pendingOps.length) setExitPrompt(true)
    else setOpen(false)
  }

  const save = useApiMutation({
    mutationFn: () => {
      if (!p.art) throw new Error("The deck is still loading.")
      if (sessionBaseVersion === null) throw new Error("The deck version is still loading.")
      return api.publishSlideOps(
        p.shortId,
        pendingOps,
        sessionBaseVersion,
        `Organized ${slides.length} slide${slides.length === 1 ? "" : "s"}`,
      )
    },
    success: (art) => `Saved as v${art.current_version}`,
    onSuccess: () => {
      setOpen(false)
      setHistory([])
      setTrash([])
      p.onSaved()
    },
  })

  return {
    open,
    slides,
    trash,
    selectedKey,
    selectedSlide: slides.find((slide) => slide.key === selectedKey) ?? null,
    announcement,
    dirty: pendingOps.length,
    canUndo: history.length > 0,
    saving: save.isPending,
    exitPrompt,
    start: () => reset(true),
    select,
    move,
    add,
    duplicate,
    remove,
    restoreFromTrash,
    undo,
    requestClose,
    discard: () => reset(false),
    save: () => save.mutate(),
    setExitPrompt,
  }
}

type Organizer = ReturnType<typeof useDeckOrganizer>

function OrganizerBody({ organizer, touch }: { organizer: Organizer; touch: boolean }) {
  const [dragged, setDragged] = useState<number | null>(null)
  const [dropAt, setDropAt] = useState<number | null>(null)
  const [removeKey, setRemoveKey] = useState<string | null>(null)
  const removing = organizer.slides.find((slide) => slide.key === removeKey)
  return (
    <>
      <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
        <div>
          <SectionTitle as="h2">Slides</SectionTitle>
          <p className="text-2xs text-muted-foreground">
            {organizer.slides.length} slide{organizer.slides.length === 1 ? "" : "s"} ·{" "}
            {organizer.dirty ? "Unsaved changes" : "No unsaved changes"}
          </p>
        </div>
        <Button size="sm" data-testid="deck-add-slide" onClick={organizer.add}>
          <Plus /> Add slide
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2" data-testid="deck-slide-list">
        <ul className="flex flex-col gap-1.5">
          {organizer.slides.map((slide, i) => {
            const selected = organizer.selectedKey === slide.key
            return (
              <li
                key={slide.key}
                data-testid={`deck-slide-card-${i + 1}`}
                data-selected={selected || undefined}
                onDragEnter={(event) => {
                  event.preventDefault()
                  if (dragged !== null) setDropAt(i)
                }}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault()
                  if (dragged !== null) organizer.move(dragged, i)
                  setDragged(null)
                  setDropAt(null)
                }}
                className={cn(
                  "group relative flex shrink-0 items-center gap-2 rounded-lg border bg-card p-1.5",
                  selected ? "border-primary/50 bg-primary/5" : "border-border hover:bg-secondary",
                  dragged === i && "opacity-50",
                  dropAt === i &&
                    dragged !== i &&
                    "before:absolute before:inset-x-1 before:-top-1 before:h-0.5 before:rounded-full before:bg-primary",
                )}
              >
                <button
                  type="button"
                  draggable
                  onDragStart={() => {
                    setDragged(i)
                    setDropAt(i)
                  }}
                  onDragEnd={() => {
                    setDragged(null)
                    setDropAt(null)
                  }}
                  className={cn(
                    "grid shrink-0 cursor-grab touch-none place-items-center rounded-md text-muted-foreground outline-none focus-visible:outline-2 focus-visible:outline-ring active:cursor-grabbing",
                    touch ? "size-10" : "size-7",
                  )}
                  aria-label={`Drag slide ${i + 1}`}
                  aria-grabbed={dragged === i}
                  data-testid={`deck-slide-drag-${i + 1}`}
                >
                  <GripVertical className="size-4" />
                </button>
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left outline-none focus-visible:outline-2 focus-visible:outline-ring"
                  aria-label={`Slide ${i + 1}, ${slide.label}`}
                  aria-current={selected ? "true" : undefined}
                  data-testid={`deck-slide-select-${i + 1}`}
                  onClick={() => organizer.select(slide.key)}
                >
                  <span className="flex aspect-video w-14 shrink-0 items-center justify-center rounded border border-border bg-background font-mono text-2xs text-muted-foreground shadow-xs">
                    {i + 1}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-medium">{slide.label}</span>
                    <span className="block font-mono text-2xs text-muted-foreground">
                      Slide {i + 1}
                    </span>
                  </span>
                </button>
                <div
                  className={cn(
                    "items-center",
                    touch ? "flex" : "hidden group-hover:flex group-focus-within:flex",
                  )}
                >
                  <Button
                    variant="ghost"
                    size={touch ? "icon-lg" : "icon-xs"}
                    aria-label={`Move slide ${i + 1} up`}
                    data-testid={`deck-slide-up-${i + 1}`}
                    disabled={i === 0}
                    onClick={() => organizer.move(i, i - 1)}
                  >
                    <ArrowUp />
                  </Button>
                  <Button
                    variant="ghost"
                    size={touch ? "icon-lg" : "icon-xs"}
                    aria-label={`Move slide ${i + 1} down`}
                    data-testid={`deck-slide-down-${i + 1}`}
                    disabled={i === organizer.slides.length - 1}
                    onClick={() => organizer.move(i, i + 1)}
                  >
                    <ArrowDown />
                  </Button>
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size={touch ? "icon-lg" : "icon-xs"}
                      aria-label={`More actions for slide ${i + 1}`}
                      data-testid={`deck-slide-more-${i + 1}`}
                    >
                      <MoreHorizontal />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      data-testid={`deck-slide-duplicate-${i + 1}`}
                      onSelect={() => organizer.duplicate(slide.key)}
                    >
                      <Copy /> Duplicate
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={organizer.slides.length <= 1}
                      data-testid={`deck-slide-remove-${i + 1}`}
                      className="text-destructive"
                      onSelect={() => setRemoveKey(slide.key)}
                    >
                      <Trash2 /> Remove
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </li>
            )
          })}
        </ul>

        {organizer.trash.length > 0 && (
          <details className="mt-3 rounded-lg border border-border bg-muted/20" open>
            <summary className="cursor-pointer px-3 py-2 text-xs font-medium">
              Trash · {organizer.trash.length}
            </summary>
            <div className="flex flex-col gap-1 border-t border-border p-1.5">
              {organizer.trash.map((slide) => (
                <div key={slide.key} className="flex items-center gap-2 rounded-md px-2 py-1.5">
                  <Trash2 className="size-3.5 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-xs">{slide.label}</span>
                  <Button
                    variant="ghost"
                    size="xs"
                    data-testid="deck-trash-restore"
                    aria-label={`Restore ${slide.label}`}
                    onClick={() => organizer.restoreFromTrash(slide.key)}
                  >
                    <RotateCcw /> Restore
                  </Button>
                </div>
              ))}
            </div>
          </details>
        )}
        <p className="px-1 pt-3 text-2xs leading-4 text-muted-foreground">
          Removed slides stay here until you save. Saved versions remain recoverable in Version
          history.
        </p>
      </div>

      <div className="flex items-center gap-1.5 border-t border-border p-2.5">
        <Button
          variant="ghost"
          size="sm"
          data-testid="deck-arrange-undo"
          disabled={!organizer.canUndo}
          onClick={organizer.undo}
        >
          <RotateCcw /> Undo
        </Button>
        <span className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          data-testid="deck-arrange-close"
          onClick={organizer.requestClose}
        >
          {organizer.dirty ? "Discard" : "Done"}
        </Button>
        <Button
          size="sm"
          data-testid="deck-arrange-save"
          loading={organizer.saving}
          disabled={!organizer.dirty}
          onClick={organizer.save}
        >
          {organizer.saving ? "Saving…" : "Save changes"}
        </Button>
      </div>

      <ConfirmDialog
        open={!!removeKey}
        onOpenChange={(open) => {
          if (!open) setRemoveKey(null)
        }}
        title={`Remove ${removing?.label ?? "this slide"}?`}
        description="It will move to this session’s Trash, where you can restore it before saving. The saved deck also remains in Version history."
        confirmLabel="Remove"
        confirmTestId="deck-remove-confirm"
        onConfirm={() => {
          if (removeKey) organizer.remove(removeKey)
          setRemoveKey(null)
        }}
      />
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {organizer.announcement}
      </p>
    </>
  )
}

export function DeckOrganizer({
  organizer,
  isMobile,
}: {
  organizer: Organizer
  isMobile: boolean
}) {
  if (isMobile)
    return (
      <Sheet
        open={organizer.open}
        onOpenChange={(open) => {
          if (!open) organizer.requestClose()
        }}
      >
        <SheetContent
          side="bottom"
          showCloseButton={false}
          className="max-h-[82dvh] gap-0"
          data-testid="deck-organizer"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>Organize slides</SheetTitle>
            <SheetDescription>Add, reorder, duplicate, remove, or restore slides.</SheetDescription>
          </SheetHeader>
          <OrganizerBody organizer={organizer} touch />
        </SheetContent>
      </Sheet>
    )

  if (!organizer.open) return null
  return (
    <aside
      data-testid="deck-organizer"
      aria-label="Organize slides"
      className="flex w-72 shrink-0 flex-col border-r border-border bg-card"
    >
      <OrganizerBody organizer={organizer} touch={false} />
    </aside>
  )
}

export function DeckOrganizerDiscardDialog({ organizer }: { organizer: Organizer }) {
  return (
    <ConfirmDialog
      open={organizer.exitPrompt}
      onOpenChange={organizer.setExitPrompt}
      title="Discard slide changes?"
      description="Your unsaved arrangement and session Trash will be cleared."
      confirmLabel="Discard changes"
      confirmTestId="deck-arrange-discard-confirm"
      onConfirm={organizer.discard}
    />
  )
}
