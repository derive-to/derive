import type {
  LinkedBundleDiagramNode,
  LinkedBundleNodeExplanation,
} from "./linked-bundle-node-details"

function DetailField({
  label,
  value,
  prominent = false,
  source,
  className = "",
}: {
  label: string
  value: string | null
  prominent?: boolean
  source?: LinkedBundleNodeExplanation["source"]
  className?: string
}) {
  return (
    <div className={className}>
      <dt className="flex flex-wrap items-center gap-2 font-mono text-2xs uppercase tracking-[0.08em] text-muted-foreground">
        {label}
        {source === "workflow" ? (
          <span className="rounded border border-border bg-muted/50 px-1.5 py-0.5 normal-case tracking-normal">
            From workflow
          </span>
        ) : null}
      </dt>
      <dd
        className={
          prominent
            ? "mt-1 text-sm leading-relaxed text-foreground"
            : "mt-1 leading-relaxed text-foreground"
        }
      >
        {value ?? (prominent ? "No details added yet." : "Not stated")}
      </dd>
    </div>
  )
}

function MetadataField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="font-mono text-2xs uppercase tracking-[0.08em] text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-0.5 text-foreground">{value}</dd>
    </div>
  )
}

export function LinkedBundleNodeDetailsPanel({
  node,
  explanation,
  canEdit,
}: {
  node: LinkedBundleDiagramNode
  explanation: LinkedBundleNodeExplanation
  canEdit: boolean
}) {
  return (
    <>
      <dl className="mt-3 grid overflow-hidden rounded-lg border border-border-soft bg-background/40 text-xs sm:grid-cols-2">
        <DetailField
          label="What happens"
          value={explanation.whatHappens}
          source={explanation.source}
          prominent
          className="border-b border-border-soft p-3 sm:col-span-2"
        />
        <DetailField
          label="Owner / context"
          value={explanation.ownerContext}
          className="border-b border-border-soft p-3 sm:border-r"
        />
        <DetailField
          label="Expected output"
          value={explanation.expectedOutput}
          className="border-b border-border-soft p-3"
        />
        <DetailField
          label="Exit condition"
          value={explanation.exitCondition}
          className="p-3 sm:col-span-2"
        />
      </dl>

      {!explanation.whatHappens ? (
        <div
          className="mt-3 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-xs leading-relaxed text-warning"
          data-testid="bundle-node-detail-advisory"
        >
          Preview advisory: this node has no note or workflow instruction/result.
          {canEdit
            ? " Add a note so people can understand what happens here."
            : " Ask an editor to add a note."}
        </div>
      ) : null}

      <dl className="mt-3 grid gap-x-5 gap-y-2 text-xs sm:grid-cols-2 lg:grid-cols-3">
        <MetadataField label="Confidence" value={node.confidence?.level ?? "Not stated"} />
        <MetadataField label="Confidence basis" value={node.confidence?.basis ?? "Not stated"} />
        <MetadataField
          label="Help status"
          value={node.help ? (node.help.needed ? "Needs help" : "No help needed") : "Not stated"}
        />
        <MetadataField label="Help question" value={node.help?.question ?? "Not stated"} />
        <MetadataField label="Can continue" value={node.help?.can_continue ?? "Not stated"} />
      </dl>
    </>
  )
}
