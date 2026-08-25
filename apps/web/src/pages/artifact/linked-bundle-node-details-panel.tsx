import type { LinkedBundleNodeNote } from "./linked-bundle-node-details"

export function LinkedBundleNodeDetailsPanel({
  note,
  canEdit,
}: {
  note: LinkedBundleNodeNote
  canEdit: boolean
}) {
  return (
    <>
      <dl className="mt-3 rounded-lg border border-border-soft bg-background/40 p-3 text-xs">
        <dt className="flex flex-wrap items-center gap-2 font-mono text-2xs uppercase tracking-[0.08em] text-muted-foreground">
          Note
          {note.source === "workflow" ? (
            <span className="rounded border border-border bg-muted/50 px-1.5 py-0.5 normal-case tracking-normal">
              Drafted from workflow
            </span>
          ) : null}
        </dt>
        <dd className="mt-1 text-sm leading-relaxed text-foreground">
          {note.text ?? "No note yet."}
        </dd>
      </dl>

      {!note.text ? (
        <div
          className="mt-3 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-xs leading-relaxed text-warning"
          data-testid="bundle-node-detail-advisory"
        >
          Preview advisory: this node has no note or workflow description.
          {canEdit
            ? " Add a short note so people can understand it."
            : " Ask an editor to add a note."}
        </div>
      ) : null}
    </>
  )
}
