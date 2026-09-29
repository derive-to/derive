import { useState } from "react"
import { Icon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type { EditChange, EditConflict, SaveStatus } from "./use-inline-edit"

export type EditViewport = "auto" | "tablet" | "mobile"

/**
 * The mode strip for inline editing — a slim band between the workbench header and
 * the document, IN FLOW rather than floating over it.
 *
 * It floated once, bottom-center, and did two things wrong at the same time: it
 * covered the document text it sat on (swallowing clicks meant for that text), and
 * edit mode was otherwise pixel-identical to reading, so nothing on screen said the
 * page had become editable. A band in the layout can't occlude anything, and it
 * states the mode where the eye already is — under the title, beside the verb that
 * opened it.
 *
 * It is also the mode's CONTROL SURFACE. Every verb the editor has — undo, redo,
 * bold, italic, link — existed only as a keyboard chord, which meant it existed only
 * for whoever already knew. They are buttons here, in the order you reach for them:
 * history first (what you just did), then the formatting (what you're about to do).
 * Each drives the same call its shortcut does, so a control and its chord can never
 * mean different things. Disabled is honest — B / I / link light up only when a
 * selection they could act on exists.
 *
 * Every edit saves itself, so there is no Save and no Discard: the right end is where
 * the save is (the status, which opens this session's changes) and Done.
 */
export function EditBar({
  status,
  changes = [],
  conflicts = [],
  closing = false,
  touch = false,
  canUndo = false,
  canRedo = false,
  canFormat = false,
  allowElementEdits = false,
  viewport = "auto",
  onUndo,
  onRedo,
  onFormat,
  onViewport,
  onRevealChange,
  onRevertChange,
  onResolve,
  onDone,
  live = true,
  onSave,
}: {
  status: SaveStatus
  /** This session's changes, as the document reports them. */
  changes?: EditChange[]
  /** Blocks someone else changed under unsaved words: each needs a choice. */
  conflicts?: EditConflict[]
  /** Done is saving what's left before it leaves. */
  closing?: boolean
  /** Phone/tablet: the verbs get real 44px touch targets and the hint says "tap". */
  touch?: boolean
  /** Live from the document: history depth and whether a formattable run is selected. */
  canUndo?: boolean
  canRedo?: boolean
  canFormat?: boolean
  /** HTML/deck sources can persist resize operations; rendered Markdown cannot. */
  allowElementEdits?: boolean
  /** Resize the real artifact iframe so authored media queries run during editing. */
  viewport?: EditViewport
  onUndo: () => void
  onRedo: () => void
  /** A link needs a URL; the bar asks for it (below) before it sends one. */
  onFormat: (kind: "b" | "i" | "a", href?: string) => void
  onViewport?: (viewport: EditViewport) => void
  /** A row of the changes list: show where it is, or put just that back. */
  onRevealChange?: (change: EditChange) => void
  onRevertChange?: (change: EditChange) => void
  onResolve?: (id: string, mine: boolean) => void
  onDone: () => void
  /** Edits save themselves (live auto-save); otherwise they wait for Save (⌘S) or Done. */
  live?: boolean
  onSave?: () => void
}) {
  // Apple's 44px minimum. The strip grows a few px on a phone; a target you can
  // actually hit is worth more there than the vertical space it costs.
  const hit = touch ? "h-11 px-4" : ""
  const toolSize = touch ? "icon" : "icon-xs"
  // The link verb, mid-question. It asks HERE rather than from inside the document,
  // where the only dialog available to a sandboxed frame is a bare window.prompt —
  // and the document has already stashed the selected range, so taking focus up to
  // this field costs nothing.
  const [href, setHref] = useState<string | null>(null)
  const commitLink = () => {
    const url = (href ?? "").trim()
    setHref(null)
    if (url) onFormat("a", url)
  }
  return (
    // role=status + aria-live: entering the mode unmounts the Edit button the user
    // just pressed, so focus falls to body and a screen reader would otherwise get
    // no signal at all that the document became editable.
    <div
      data-testid="inline-edit-bar"
      role="status"
      aria-live="polite"
      className="flex shrink-0 flex-wrap items-center gap-2 border-border border-b bg-accent/40 py-1.5 pr-2 pl-4 sm:flex-nowrap"
    >
      <Icon name="pencil" size={14} className="shrink-0 text-muted-foreground" />
      {/* The word is the mode's name; it drops on a phone, where the pencil and the
          live controls already say what this is and every px of width is spoken for. */}
      <span className="hidden font-medium text-foreground text-xs sm:inline">Editing</span>

      {/* History, then formatting: two groups, held apart by a hairline rather than
          gaps alone, because they answer different questions. */}
      <div className="flex shrink-0 items-center gap-0.5">
        <HistoryButton
          testId="inline-edit-undo"
          icon="undo"
          label="Undo"
          chord="⌘Z"
          touch={touch}
          disabled={!canUndo}
          onClick={onUndo}
        />
        <HistoryButton
          testId="inline-edit-redo"
          icon="redo"
          label="Redo"
          chord="⇧⌘Z"
          touch={touch}
          disabled={!canRedo}
          onClick={onRedo}
        />
        <span aria-hidden className="mx-1 h-4 w-px bg-border" />
        <ToolButton
          testId="inline-edit-bold"
          icon="bold"
          label="Bold"
          chord="⌘B"
          size={toolSize}
          disabled={!canFormat}
          onClick={() => onFormat("b")}
        />
        <ToolButton
          testId="inline-edit-italic"
          icon="italic"
          label="Italic"
          chord="⌘I"
          size={toolSize}
          disabled={!canFormat}
          onClick={() => onFormat("i")}
        />
        <ToolButton
          testId="inline-edit-link"
          icon="link"
          label="Link"
          chord="⌘K"
          size={toolSize}
          disabled={!canFormat && href === null}
          onClick={() => setHref("")}
        />
      </div>

      {allowElementEdits && onViewport && (
        <fieldset
          className="flex min-w-0 shrink-0 items-center gap-0.5 rounded-md border border-border bg-background/70 p-0.5"
          aria-label="Responsive preview width"
          data-testid="inline-edit-viewports"
        >
          {(
            [
              ["auto", "Fluid", "Use the available preview width"],
              ["tablet", "768", "Preview at tablet width, 768 pixels"],
              ["mobile", "390", "Preview at mobile width, 390 pixels"],
            ] as const
          ).map(([value, label, title]) => (
            <button
              key={value}
              type="button"
              aria-label={title}
              aria-pressed={viewport === value}
              title={title}
              data-testid={`inline-edit-viewport-${value}`}
              className={cn(
                "h-6 rounded px-2 font-mono text-2xs transition-colors",
                viewport === value
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
              onClick={() => onViewport(value)}
            >
              {label}
            </button>
          ))}
        </fieldset>
      )}

      {/* Asking for the URL takes the status line's place: one line, one question,
          gone the moment it's answered. Enter applies it, Escape drops it. */}
      {href !== null && (
        <input
          // biome-ignore lint/a11y/noAutofocus: the field IS the question the button just asked.
          autoFocus
          aria-label="Link to"
          data-testid="inline-edit-link-input"
          placeholder="Link to…"
          className="min-w-0 flex-1 rounded-sm bg-transparent px-1 text-xs outline-none ring-1 ring-border focus:ring-ring"
          value={href}
          onChange={(e) => setHref(e.target.value)}
          onBlur={commitLink}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              commitLink()
            } else if (e.key === "Escape") {
              e.preventDefault()
              setHref(null)
            }
            e.stopPropagation()
          }}
        />
      )}

      {/* At rest the hint says what a click does. It yields first under width
          pressure — the controls and the save status matter more than the sentence. */}
      {changes.length === 0 && (
        <span
          className={cn(
            "hidden min-w-0 truncate text-2xs text-muted-foreground lg:inline",
            href !== null && "lg:hidden",
          )}
        >
          {allowElementEdits
            ? touch
              ? "tap text to edit; tap a card or image to move or resize it"
              : `click text to edit; click around it to move a block${live ? " · edits save on their own" : ""}`
            : touch
              ? "tap text to edit; select an image to replace it"
              : `click text to edit; select an image to replace it${live ? " · edits save on their own" : ""}`}
        </span>
      )}
      {/* A phone gives the status and Done their own row. This is intentionally a
          layout change rather than horizontal scrolling: Undo must not compete with
          the way to finish the session. */}
      <div className="ml-auto flex shrink-0 items-center gap-1 max-sm:basis-full max-sm:justify-end">
        <SessionMenu
          status={status}
          changes={changes}
          conflicts={conflicts}
          hidden={href !== null}
          onReveal={onRevealChange}
          onRevert={onRevertChange}
          onResolve={onResolve}
        />
        {onSave && <SaveButton live={live} status={status} onSave={onSave} className={hit} />}
        <Button
          variant="ghost"
          size="sm"
          data-testid="inline-edit-done"
          onClick={onDone}
          loading={closing}
          className={hit}
        >
          Done
          <Kbd aria-hidden className="max-sm:hidden">
            Esc
          </Kbd>
        </Button>
      </div>
    </div>
  )
}

/** Save, where edits wait for it (no live auto-save) and some are waiting. */
export function SaveButton({
  live,
  status,
  onSave,
  className,
  testId = "inline-edit-save",
}: {
  live: boolean
  status: SaveStatus
  onSave: () => void
  className?: string
  testId?: string
}) {
  if (live || (status.kind !== "pending" && status.kind !== "error")) return null
  return (
    <Button variant="default" size="sm" data-testid={testId} onClick={onSave} className={className}>
      Save
      <Kbd aria-hidden className="max-sm:hidden">
        ⌘S
      </Kbd>
    </Button>
  )
}

const STATUS_COPY: Record<SaveStatus["kind"], string> = {
  pending: "Edited",
  saving: "Saving…",
  saved: "All changes saved",
  offline: "Offline",
  conflict: "Needs a decision",
  error: "Not saved",
}
const STATUS_DOT: Record<SaveStatus["kind"], string> = {
  pending: "bg-muted-foreground/60",
  saving: "bg-warning",
  saved: "bg-success",
  offline: "bg-warning",
  conflict: "bg-destructive",
  error: "bg-destructive",
}
/** What the save indicator says, in one place (the bar and the Inspect panel). */
export const statusLabel = (status: SaveStatus) =>
  status.kind === "offline"
    ? `Offline — ${status.waiting || "your"} edit${status.waiting === 1 ? "" : "s"} waiting`
    : STATUS_COPY[status.kind]
export function StatusDot({ status }: { status: SaveStatus }) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-2 shrink-0 rounded-full transition-colors",
        STATUS_DOT[status.kind],
        status.kind === "saving" && "animate-pulse",
      )}
    />
  )
}

/** The save status, which opens this session: each change before → after, where it
 *  is, and ↺ to put back just that one; a block someone else changed under your
 *  unsaved words asks, first, whose words to keep. Kept across saves: a save is not
 *  the end of anything. */
function SessionMenu({
  status,
  changes,
  conflicts,
  hidden,
  onReveal,
  onRevert,
  onResolve,
}: {
  status: SaveStatus
  changes: EditChange[]
  conflicts: EditConflict[]
  hidden: boolean
  onReveal?: (change: EditChange) => void
  onRevert?: (change: EditChange) => void
  onResolve?: (id: string, mine: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  // A choice to make opens the list by itself: it is the one state that needs you.
  const [asked, setAsked] = useState(0)
  if (conflicts.length > asked) {
    setAsked(conflicts.length)
    setOpen(true)
  } else if (conflicts.length < asked) setAsked(conflicts.length)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          data-testid="inline-edit-status"
          data-status={status.kind}
          data-saved-rev={status.savedRev}
          aria-live="polite"
          className={cn("shrink-0 gap-1.5 text-2xs text-foreground", hidden && "hidden")}
        >
          <StatusDot status={status} />
          <span className="truncate">{statusLabel(status)}</span>
          {changes.length > 0 && (
            <span className="text-muted-foreground tabular-nums">· {changes.length}</span>
          )}
          <Icon name="caret" size={12} className="text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-96 max-w-[calc(100vw-1rem)] gap-1 p-2"
        // It can open by itself (a choice to make): focus stays where the person had
        // it, and moving it elsewhere doesn't dismiss the question.
        onOpenAutoFocus={(e) => e.preventDefault()}
        onFocusOutside={(e) => e.preventDefault()}
      >
        <p className="flex justify-between px-2 pt-1 pb-1.5 font-medium text-2xs text-muted-foreground uppercase tracking-wide">
          <span>This session</span>
          <span className="tabular-nums">{changes.length || ""}</span>
        </p>
        {conflicts.map((c) => (
          <div
            key={c.id}
            data-testid="inline-edit-conflict"
            className="mx-1 mb-1 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs"
          >
            <p className="text-2xs text-muted-foreground">
              {c.where} — {c.by || "Someone"} changed it just now
            </p>
            <p className="mt-1 break-words">
              <span className="text-muted-foreground">Yours: </span>
              {c.mine || "(empty)"}
            </p>
            <p className="mt-0.5 break-words">
              <span className="text-muted-foreground">{c.by ? `${c.by}'s` : "Theirs"}: </span>
              {c.theirs || "(empty)"}
            </p>
            <div className="mt-2 flex gap-1">
              <Button
                size="xs"
                data-testid="inline-edit-keep-mine"
                onClick={() => onResolve?.(c.id, true)}
              >
                Keep mine
              </Button>
              <Button
                size="xs"
                variant="ghost"
                data-testid="inline-edit-use-theirs"
                onClick={() => onResolve?.(c.id, false)}
              >
                Use {c.by ? `${c.by}'s` : "theirs"}
              </Button>
            </div>
          </div>
        ))}
        <ul
          className="flex max-h-72 flex-col gap-0.5 overflow-auto"
          data-testid="inline-edit-changes-list"
        >
          {changes.length ? (
            changes.map((c) => (
              <li key={c.id} className="flex items-start gap-1 rounded-md hover:bg-accent">
                <button
                  type="button"
                  data-testid="inline-edit-change"
                  className="min-w-0 flex-1 px-2 py-1.5 text-left text-xs"
                  onClick={() => onReveal?.(c)}
                >
                  <span className="block truncate text-2xs text-muted-foreground">
                    {c.where} · {status.kind === "saved" ? "saved" : "saving"}
                  </span>
                  {c.from !== undefined && c.to !== undefined ? (
                    <span className="block break-words">
                      <s className="text-muted-foreground">{c.from || "(empty)"}</s>
                      {" → "}
                      <span className="text-primary">{c.to || "(empty)"}</span>
                    </span>
                  ) : (
                    <span className="block break-words">{c.what}</span>
                  )}
                </button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Undo this change: ${c.where}`}
                  title="Undo just this change"
                  data-testid="inline-edit-change-revert"
                  className="mt-1 mr-1 text-muted-foreground"
                  onClick={() => onRevert?.(c)}
                >
                  <Icon name="undo" size={13} />
                </Button>
              </li>
            ))
          ) : conflicts.length ? null : (
            <li className="px-2 py-1.5 text-muted-foreground text-xs">
              No edits yet this session.
            </li>
          )}
        </ul>
      </PopoverContent>
    </Popover>
  )
}

/** History is the escape hatch, so its verbs stay written on the surface instead
 *  of being discoverable only by recognizing an icon or opening a tooltip. */
function HistoryButton({
  testId,
  icon,
  label,
  chord,
  touch,
  disabled,
  onClick,
}: {
  testId: string
  icon: "undo" | "redo"
  label: string
  chord: string
  touch: boolean
  disabled: boolean
  onClick: () => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          aria-label={label}
          data-testid={testId}
          disabled={disabled}
          onMouseDown={(e) => e.preventDefault()}
          onClick={onClick}
          className={cn(touch && "h-11", disabled && "opacity-40")}
        >
          <Icon name={icon} size={15} className="text-muted-foreground" />
          <span>{label}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {label} <Kbd>{chord}</Kbd>
      </TooltipContent>
    </Tooltip>
  )
}

/** One control in the bar: an icon, its name, and the chord that does the same thing
 *  — so the shortcuts are learnable from the surface instead of from documentation. */
function ToolButton({
  testId,
  icon,
  label,
  chord,
  size,
  disabled,
  onClick,
}: {
  testId: string
  icon: "undo" | "redo" | "bold" | "italic" | "link"
  label: string
  chord: string
  size: "icon" | "icon-xs"
  disabled: boolean
  onClick: () => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size={size}
          aria-label={label}
          data-testid={testId}
          disabled={disabled}
          // The pointer must not leave the document: a selection lost to a button
          // press is a selection the format verb can no longer act on.
          onMouseDown={(e) => e.preventDefault()}
          onClick={onClick}
          className={cn(disabled && "opacity-40")}
        >
          <Icon name={icon} size={15} className="text-muted-foreground" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {label} <Kbd>{chord}</Kbd>
      </TooltipContent>
    </Tooltip>
  )
}
