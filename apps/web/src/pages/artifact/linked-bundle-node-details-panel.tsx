import { Icon } from "@/components/icons"
import { Eyebrow } from "@/components/shared/section-eyebrow"
import { Button } from "@/components/ui/button"
import type { LinkedBundleNodeNote } from "./linked-bundle-node-details"

export function LinkedBundleNodeDetailsPanel({
  note,
  onEdit,
}: {
  note: LinkedBundleNodeNote
  onEdit?: () => void
}) {
  return (
    <div className="mt-3 rounded-lg border border-border-soft bg-background/40 p-3 text-xs">
      <div className="flex items-start justify-between gap-3">
        <Eyebrow as="div" className="flex flex-wrap items-center gap-2">
          Note
          {note.source === "workflow" ? (
            <span className="rounded border border-border bg-muted/50 px-1.5 py-0.5 normal-case tracking-normal">
              Drafted from workflow
            </span>
          ) : null}
        </Eyebrow>
        {onEdit ? (
          <Button
            variant="ghost"
            size="sm"
            className="-mr-1 -mt-1 h-7 px-2 text-xs"
            data-testid="bundle-selection-edit-note"
            onClick={onEdit}
          >
            <Icon name="pencil" size={13} /> Edit
          </Button>
        ) : null}
      </div>
      <p className="mt-1 text-sm leading-relaxed text-foreground">{note.text ?? "No note yet."}</p>
      {!note.text ? (
        <p
          className="mt-2 text-xs leading-relaxed text-warning"
          data-testid="bundle-node-detail-advisory"
        >
          Preview advisory: this node has no note or workflow description.
          {onEdit ? " Add a short note." : " Ask an editor to add one."}
        </p>
      ) : null}
    </div>
  )
}
