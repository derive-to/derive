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
  touch = false,
  onSave,
  onDiscard,
  onDone,
}: {
  dirty: number
  canPublish: boolean
  saving: boolean
  /** Phone/tablet: the verbs get real 44px touch targets and the hint says "tap". */
  touch?: boolean
  onSave: () => void
  onDiscard: () => void
  onDone: () => void
}) {
  // Apple's 44px minimum. The strip grows a few px on a phone; a target you can
  // actually hit is worth more there than the vertical space it costs.
  const hit = touch ? "h-11 px-4" : ""
  return (
    // role=status + aria-live: entering the mode unmounts the Edit button the user
    // just pressed, so focus falls to body and a screen reader would otherwise get
    // no signal at all that the document became editable.
    <div
      data-testid="inline-edit-bar"
      role="status"
      aria-live="polite"
      className="flex shrink-0 items-center gap-2 border-border border-b bg-accent/40 py-1.5 pr-2 pl-4"
    >
      <Icon name="pencil" size={14} className="shrink-0 text-muted-foreground" />
      <span className="font-medium text-foreground text-xs">Editing</span>
      <span className="truncate text-2xs text-muted-foreground">
        {dirty === 0
          ? touch
            ? "tap any text to change it, or an image to replace it"
            : "click any text to change it, or an image to replace it"
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
              className={hit}
            >
              Discard
            </Button>
            <Button
              variant="default"
              size="sm"
              data-testid="inline-edit-save"
              onClick={onSave}
              loading={saving}
              className={hit}
            >
              {canPublish ? "Save" : "Suggest"}
              <Kbd aria-hidden className="max-sm:hidden">
                ⌘S
              </Kbd>
            </Button>
          </>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            data-testid="inline-edit-done"
            onClick={onDone}
            className={hit}
          >
            Done
            <Kbd aria-hidden className="max-sm:hidden">
              Esc
            </Kbd>
          </Button>
        )}
      </div>
    </div>
  )
}
