import { useState } from "react"
import { Icon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { cn } from "@/lib/utils"

type FormatKind = "b" | "i" | "a"

/**
 * The contextual companion to the document's existing Edit mode.
 *
 * The document remains the canvas: click text and type there, or manipulate an
 * element in place. Inspect explains the current context and exposes the same
 * formatting, history, and save commands as the edit bar. Both surfaces drive one
 * frame-owned history stack, so Undo has one meaning across text and layout edits.
 */
export function ArtifactInspect({
  dirty,
  saving,
  canUndo,
  canRedo,
  canFormat,
  textActive,
  textKind,
  selectedText,
  video,
  onSceneEdit,
  onUndo,
  onRedo,
  onFormat,
  onSave,
  onDone,
}: {
  dirty: number
  saving: boolean
  canUndo: boolean
  canRedo: boolean
  canFormat: boolean
  textActive: boolean
  textKind: string
  selectedText: string
  video?: {
    i: number
    total: number
    id: string
    durationMs: number
    transition: string
    transitionMs: number
    caption: string
  } | null
  onSceneEdit?: (edit: Record<string, unknown>) => void
  onUndo: () => void
  onRedo: () => void
  onFormat: (kind: FormatKind, href?: string) => void
  onSave: () => void
  onDone: () => void
}) {
  return (
    <section
      aria-label="Inspect HTML editing"
      className="flex min-h-0 flex-1 flex-col overflow-auto p-4"
      data-testid="artifact-inspect"
    >
      <div className="flex items-center gap-2">
        <span className="grid size-7 place-items-center rounded-md bg-muted text-muted-foreground">
          <Icon name="edit" size={15} />
        </span>
        <div className="min-w-0">
          <h2 className="font-medium text-foreground text-sm">Inspect</h2>
          <p className="text-2xs text-muted-foreground">Editing HTML safely</p>
        </div>
      </div>

      {textActive ? (
        <TextInspect
          canFormat={canFormat}
          kind={textKind || "Text"}
          selectedText={selectedText}
          saving={saving}
          onFormat={onFormat}
        />
      ) : video && onSceneEdit ? (
        <SceneInspect video={video} onEdit={onSceneEdit} saving={saving} />
      ) : (
        <ChooseInspect />
      )}

      <SessionControls
        dirty={dirty}
        saving={saving}
        canUndo={canUndo}
        canRedo={canRedo}
        onUndo={onUndo}
        onRedo={onRedo}
        onSave={onSave}
        onDone={onDone}
      />
    </section>
  )
}

function SceneInspect({
  video,
  onEdit,
  saving,
}: {
  video: {
    i: number
    total: number
    id: string
    durationMs: number
    transition: string
    transitionMs: number
    caption: string
  }
  onEdit: (edit: Record<string, unknown>) => void
  saving: boolean
}) {
  const update = (values: Record<string, unknown>) =>
    onEdit({ op: "update", id: video.id, ...values })
  return (
    <div data-testid="artifact-inspect-scene" className="mt-6 space-y-5">
      <div>
        <p className="text-2xs text-muted-foreground uppercase tracking-wide">
          Scene {video.i + 1} of {video.total}
        </p>
        <h3 className="mt-1 font-medium text-foreground text-sm">Scene timing and flow</h3>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Edit words directly on the canvas. Scene controls stay here in the same editing session.
        </p>
      </div>
      <label className="grid gap-1.5 text-xs text-muted-foreground">
        Duration
        <div className="flex items-center gap-2">
          <input
            data-testid="artifact-inspect-scene-duration"
            key={`${video.id}-duration-${video.durationMs}`}
            type="number"
            min={1}
            max={30}
            step={0.5}
            defaultValue={video.durationMs / 1000}
            disabled={saving}
            className="h-9 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2.5 text-sm text-foreground"
            onBlur={(e) => update({ durationMs: Math.round(Number(e.target.value) * 1000) })}
          />
          <span>sec</span>
        </div>
      </label>
      <label className="grid gap-1.5 text-xs text-muted-foreground">
        Transition
        <select
          data-testid="artifact-inspect-scene-transition"
          key={`${video.id}-transition-${video.transition}`}
          defaultValue={video.transition}
          disabled={saving}
          className="h-9 rounded-md border border-input bg-transparent px-2.5 text-sm text-foreground"
          onChange={(e) => update({ transition: e.target.value })}
        >
          <option value="cut">Cut</option>
          <option value="fade">Fade</option>
          <option value="dissolve">Dissolve</option>
          <option value="slide">Slide</option>
        </select>
      </label>
      <label className="grid gap-1.5 text-xs text-muted-foreground">
        Caption
        <textarea
          data-testid="artifact-inspect-scene-caption"
          key={`${video.id}-caption-${video.caption}`}
          defaultValue={video.caption}
          maxLength={500}
          disabled={saving}
          className="min-h-16 resize-y rounded-md border border-input bg-transparent px-2.5 py-2 text-sm text-foreground"
          onBlur={(e) => update({ caption: e.target.value })}
        />
      </label>
      <label className="grid gap-1.5 text-xs text-muted-foreground">
        Transition duration
        <div className="flex items-center gap-2">
          <input
            data-testid="artifact-inspect-scene-transition-duration"
            key={`${video.id}-transition-duration-${video.transitionMs}`}
            type="number"
            min={0.1}
            max={2}
            step={0.1}
            defaultValue={video.transitionMs / 1000}
            disabled={saving || video.transition === "cut"}
            className="h-9 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2.5 text-sm text-foreground"
            onBlur={(e) => update({ transitionMs: Math.round(Number(e.target.value) * 1000) })}
          />
          <span>sec</span>
        </div>
      </label>
      <div className="grid grid-cols-2 gap-2">
        <Button
          data-testid="artifact-inspect-scene-earlier"
          variant="outline"
          size="sm"
          disabled={saving || video.i === 0}
          onClick={() => onEdit({ op: "move", id: video.id, direction: "previous" })}
        >
          Move earlier
        </Button>
        <Button
          data-testid="artifact-inspect-scene-later"
          variant="outline"
          size="sm"
          disabled={saving || video.i === video.total - 1}
          onClick={() => onEdit({ op: "move", id: video.id, direction: "next" })}
        >
          Move later
        </Button>
        <Button
          data-testid="artifact-inspect-scene-duplicate"
          variant="outline"
          size="sm"
          disabled={saving}
          onClick={() => onEdit({ op: "duplicate", id: video.id })}
        >
          Duplicate
        </Button>
        <Button
          data-testid="artifact-inspect-scene-delete"
          variant="outline"
          size="sm"
          disabled={saving || video.total <= 1}
          onClick={() => onEdit({ op: "delete", id: video.id })}
        >
          Delete
        </Button>
      </div>
    </div>
  )
}

function TextInspect({
  canFormat,
  kind,
  selectedText,
  saving,
  onFormat,
}: {
  canFormat: boolean
  kind: string
  selectedText: string
  saving: boolean
  onFormat: (kind: FormatKind, href?: string) => void
}) {
  const [href, setHref] = useState<string | null>(null)
  const commitLink = () => {
    const url = (href ?? "").trim()
    setHref(null)
    if (url) onFormat("a", url)
  }

  return (
    <div data-testid="artifact-inspect-text" className="mt-6">
      <p className="text-2xs text-muted-foreground uppercase tracking-wide">{kind}</p>
      <h3 className="mt-1 font-medium text-foreground text-sm">
        {canFormat ? "Format the selection" : "Edit directly in the document"}
      </h3>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">
        Type where the caret is. Select words to add emphasis or a link; every change joins the same
        undo history.
      </p>

      {selectedText ? (
        <blockquote
          title={selectedText}
          className="mt-4 truncate border-border border-y py-3 text-foreground text-sm"
        >
          “{selectedText}”
        </blockquote>
      ) : (
        <p className="mt-4 border-border border-y py-3 text-xs text-muted-foreground">
          Select words in the document to enable formatting.
        </p>
      )}

      <fieldset className="mt-4 grid grid-cols-3 gap-2" aria-label="Text formatting">
        <FormatButton
          testId="artifact-inspect-bold"
          icon="bold"
          label="Bold"
          disabled={!canFormat || saving}
          onClick={() => onFormat("b")}
        />
        <FormatButton
          testId="artifact-inspect-italic"
          icon="italic"
          label="Italic"
          disabled={!canFormat || saving}
          onClick={() => onFormat("i")}
        />
        <FormatButton
          testId="artifact-inspect-link"
          icon="link"
          label="Link"
          disabled={(!canFormat && href === null) || saving}
          onClick={() => setHref("")}
        />
      </fieldset>

      {href !== null && (
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            commitLink()
          }}
        >
          <input
            // biome-ignore lint/a11y/noAutofocus: clicking Link explicitly opens this field.
            autoFocus
            aria-label="Link to"
            data-testid="artifact-inspect-link-input"
            placeholder="https://…"
            className="h-8 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            value={href}
            onChange={(e) => setHref(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault()
                setHref(null)
              }
              e.stopPropagation()
            }}
          />
          <Button
            size="sm"
            type="submit"
            data-testid="artifact-inspect-link-apply"
            disabled={!href.trim() || saving}
          >
            Apply
          </Button>
        </form>
      )}

      <div className="mt-5 space-y-2 text-xs text-muted-foreground">
        <p className="flex items-center justify-between gap-3">
          <span>New line</span>
          <Kbd>Enter</Kbd>
        </p>
        <p className="flex items-center justify-between gap-3">
          <span>Save changes</span>
          <Kbd>⌘S</Kbd>
        </p>
      </div>
    </div>
  )
}

function FormatButton({
  testId,
  icon,
  label,
  disabled,
  onClick,
}: {
  testId: string
  icon: "bold" | "italic" | "link"
  label: string
  disabled: boolean
  onClick: () => void
}) {
  return (
    <Button
      variant="outline"
      size="sm"
      data-testid={testId}
      disabled={disabled}
      // Retain the selection inside the artifact frame while using this host control.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className="min-w-0"
    >
      <Icon name={icon} size={14} />
      <span className="truncate">{label}</span>
    </Button>
  )
}

function ChooseInspect() {
  return (
    <div data-testid="artifact-inspect-choose" className="mt-6">
      <h3 className="font-medium text-foreground text-sm">Choose content in the document</h3>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">
        Click text to type in place, or select an image, media element, or marked box to adjust it
        with the surrounding layout visible.
      </p>

      <ul className="mt-5 space-y-3 border-border border-y py-4 text-sm">
        <InspectCapability
          title="Text"
          detail="Type inline; select words for bold, italic, or link."
        />
        <InspectCapability
          title="Images and media"
          detail="Resize, set exact dimensions, or replace."
        />
        <InspectCapability
          title="Marked layout boxes"
          detail="Resize only where the HTML explicitly allows it."
        />
      </ul>
    </div>
  )
}

function SessionControls({
  dirty,
  saving,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onSave,
  onDone,
}: {
  dirty: number
  saving: boolean
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
  onSave: () => void
  onDone: () => void
}) {
  return (
    <div className="mt-auto pt-6">
      <div className="flex items-center justify-between gap-3 border-border border-t pt-4">
        <div>
          <p className="font-medium text-foreground text-xs">Edit history</p>
          <p className="mt-0.5 text-2xs text-muted-foreground">Text and elements share one stack</p>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            aria-label="Undo"
            title="Undo"
            data-testid="artifact-inspect-undo"
            disabled={!canUndo || saving}
            onClick={onUndo}
          >
            <Icon name="undo" size={15} />
            Undo
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label="Redo"
            title="Redo"
            data-testid="artifact-inspect-redo"
            disabled={!canRedo || saving}
            onClick={onRedo}
          >
            <Icon name="redo" size={15} />
            Redo
          </Button>
        </div>
      </div>

      <div
        data-testid="artifact-inspect-status"
        role="status"
        className={cn(
          "mt-4 flex items-center gap-2 rounded-md px-3 py-2 text-sm",
          dirty > 0 ? "bg-primary/5 text-foreground" : "bg-muted/40 text-muted-foreground",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "size-1.5 rounded-full",
            dirty > 0 ? "bg-primary" : "bg-muted-foreground/50",
          )}
        />
        {dirty > 0 ? `${dirty} unsaved change${dirty === 1 ? "" : "s"}` : "No unsaved changes"}
      </div>

      <div className="mt-3 flex items-center gap-2">
        {dirty > 0 && (
          <Button data-testid="artifact-inspect-save" loading={saving} onClick={() => onSave()}>
            Save changes
          </Button>
        )}
        <Button
          variant={dirty > 0 ? "ghost" : "outline"}
          data-testid="artifact-inspect-done"
          disabled={saving}
          onClick={() => onDone()}
        >
          Done editing
        </Button>
      </div>
    </div>
  )
}

function InspectCapability({ title, detail }: { title: string; detail: string }) {
  return (
    <li className="flex gap-2.5">
      <Icon name="check" size={15} className="mt-0.5 text-muted-foreground" />
      <span className="min-w-0">
        <span className="block font-medium text-foreground">{title}</span>
        <span className="block pt-0.5 text-muted-foreground">{detail}</span>
      </span>
    </li>
  )
}
