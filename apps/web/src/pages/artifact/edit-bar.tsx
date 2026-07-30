import { Icon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"

/**
 * The mode strip for inline editing — a slim band between the workbench header and
 * the document, IN FLOW rather than floating over it.
 *
 * It floated once, bottom-center, and did two things wrong at the same time: it
 * covered the document text it sat on (swallowing clicks meant for that text), and
 * edit mode was otherwise pixel-identical to reading, so nothing on screen said the
 * page had become editable. A band in the layout can't occlude anything, and it
 * states the mode where the eye already is — under the title, beside the verb that
 * opened it. It stays quiet: one line, muted copy, actions right-aligned.
 */
export function EditBar({
  dirty,
  canPublish,
  saving,
  onSave,
  onDiscard,
  onDone,
}: {
  dirty: number
  canPublish: boolean
  saving: boolean
  onSave: () => void
  onDiscard: () => void
  onDone: () => void
}) {
  return (
    <div
      data-testid="inline-edit-bar"
      className="flex shrink-0 items-center gap-2 border-border border-b bg-accent/40 py-1.5 pr-2 pl-4"
    >
      <Icon name="pencil" size={14} className="shrink-0 text-muted-foreground" />
      <span className="font-medium text-foreground text-xs">Editing</span>
      <span className="truncate text-2xs text-muted-foreground">
        {dirty === 0
          ? "click any text to change it"
          : `${dirty} unsaved change${dirty === 1 ? "" : "s"}`}
      </span>
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {dirty > 0 ? (
          <>
            <Button
              variant="ghost"
              size="sm"
              data-testid="inline-edit-discard"
              onClick={onDiscard}
              disabled={saving}
            >
              Discard
            </Button>
            <Button
              variant="default"
              size="sm"
              data-testid="inline-edit-save"
              onClick={onSave}
              loading={saving}
            >
              {canPublish ? "Save" : "Suggest"}
              <Kbd className="max-sm:hidden">⌘S</Kbd>
            </Button>
          </>
        ) : (
          <Button variant="ghost" size="sm" data-testid="inline-edit-done" onClick={onDone}>
            Done
            <Kbd className="max-sm:hidden">Esc</Kbd>
          </Button>
        )}
      </div>
    </div>
  )
}
