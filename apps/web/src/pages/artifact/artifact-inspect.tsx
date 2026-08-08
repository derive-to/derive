import { Icon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * The deliberately quiet third rail tab.
 *
 * Conversation comes first in Derive: comments are the default and chat is the
 * unanchored alternative. Inspect is not a second editor or a deck-only surface;
 * it is a small, editor-only guide to the source-safe visual adjustments that are
 * already available inside an HTML artifact. Keeping the actual manipulation in
 * the document means the element, its result, and the surrounding context stay in
 * one place instead of splitting a simple resize across two competing canvases.
 */
export function ArtifactInspect({
  active,
  dirty,
  saving,
  onStart,
  onSave,
  onDone,
}: {
  /** The document has entered the inline edit session. */
  active: boolean
  /** The same pending-change count shown by the edit bar, repeated only when useful. */
  dirty: number
  saving: boolean
  onStart: () => void
  onSave: () => void
  onDone: () => void
}) {
  return (
    <section
      aria-label="Inspect HTML elements"
      className="flex min-h-0 flex-1 flex-col overflow-auto p-4"
      data-testid="artifact-inspect"
    >
      <div className="flex items-center gap-2">
        <span className="grid size-7 place-items-center rounded-md bg-muted text-muted-foreground">
          <Icon name="edit" size={15} />
        </span>
        <div className="min-w-0">
          <h2 className="font-medium text-foreground text-sm">Inspect</h2>
          <p className="text-2xs text-muted-foreground">Source-safe HTML tools</p>
        </div>
      </div>

      {active ? (
        <ActiveInspect dirty={dirty} saving={saving} onSave={onSave} onDone={onDone} />
      ) : (
        <StartInspect onStart={onStart} />
      )}
    </section>
  )
}

function StartInspect({ onStart }: { onStart: () => void }) {
  return (
    <>
      <div className="mt-6 space-y-2">
        <h3 className="font-medium text-foreground text-sm">Adjust a visual element</h3>
        <p className="text-sm leading-6 text-muted-foreground">
          Use Inspect only when a visual HTML adjustment is quicker than changing the source.
          Conversation and direct text editing stay in their usual places.
        </p>
      </div>

      <ul className="mt-5 space-y-3 border-y border-border py-4 text-sm">
        <InspectCapability
          title="Images and media"
          detail="Resize, set exact dimensions, or replace."
        />
        <InspectCapability
          title="Marked layout boxes"
          detail="Resize a box when its source explicitly allows it."
        />
      </ul>

      <Button
        data-testid="artifact-inspect-start"
        className="mt-5 self-start"
        // Do not hand React's click event to `inlineEdit.start`: it is eventually
        // forwarded into the sandbox protocol, where a PointerEvent is not cloneable.
        onClick={() => onStart()}
      >
        <Icon name="pencil" size={16} /> Start editing
      </Button>

      <p className="mt-auto pt-6 text-2xs leading-5 text-muted-foreground">
        HTML artifacts use one set of element tools, whether they read as a document, a page, or
        slides. Markdown keeps its lightweight text editor.
      </p>
    </>
  )
}

function ActiveInspect({
  dirty,
  saving,
  onSave,
  onDone,
}: {
  dirty: number
  saving: boolean
  onSave: () => void
  onDone: () => void
}) {
  return (
    <>
      <div className="mt-6 space-y-2">
        <h3 className="font-medium text-foreground text-sm">Choose an element in the document</h3>
        <p className="text-sm leading-6 text-muted-foreground">
          Hover or select an image, media element, or marked box. Drag its corner to resize, or open
          the size control for exact dimensions.
        </p>
      </div>

      <ol className="mt-5 space-y-3 border-y border-border py-4 text-sm text-muted-foreground">
        <InspectStep n="1" text="Choose the element in the document." />
        <InspectStep n="2" text="Resize it there, with the surrounding layout in view." />
        <InspectStep n="3" text="Save from here or from the editing bar." />
      </ol>

      <div
        data-testid="artifact-inspect-status"
        className={cn(
          "mt-5 rounded-md border px-3 py-2 text-sm",
          dirty > 0
            ? "border-primary/25 bg-primary/5 text-foreground"
            : "border-border bg-muted/40 text-muted-foreground",
        )}
      >
        {dirty > 0
          ? `${dirty} unsaved change${dirty === 1 ? "" : "s"}`
          : "No unsaved visual changes"}
      </div>

      <div className="mt-3 flex items-center gap-2">
        {dirty > 0 && (
          <Button data-testid="artifact-inspect-save" disabled={saving} onClick={() => onSave()}>
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
    </>
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

function InspectStep({ n, text }: { n: string; text: string }) {
  return (
    <li className="flex gap-2.5">
      <span className="grid size-5 shrink-0 place-items-center rounded-full border border-border font-mono text-2xs text-muted-foreground">
        {n}
      </span>
      <span className="pt-0.5">{text}</span>
    </li>
  )
}
