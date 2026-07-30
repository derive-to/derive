import { Button } from "@/components/ui/button"

/**
 * The floating control for inline edit mode — a quiet pill bottom-center over the
 * document, on the same surface recipe as the selection menu (popover + ring + pop
 * shadow). Two states, one place: clean shows the invitation and Done; dirty shows
 * the change count with Discard / Save (Suggest for commenters and locked
 * artifacts). Everything else about editing happens IN the document.
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
      className="absolute bottom-4.5 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-lg bg-popover py-1 pr-1 pl-3 shadow-[var(--shadow-pop)] ring-1 ring-foreground/10"
    >
      {dirty === 0 ? (
        <>
          <span className="text-xs text-muted-foreground">Click any text to edit</span>
          <Button variant="ghost" size="sm" data-testid="inline-edit-done" onClick={onDone}>
            Done
          </Button>
        </>
      ) : (
        <>
          <span className="font-mono text-2xs tabular-nums text-muted-foreground">
            {dirty} change{dirty === 1 ? "" : "s"}
          </span>
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
          </Button>
        </>
      )}
    </div>
  )
}
