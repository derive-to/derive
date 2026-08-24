import type { Artifact } from "@/api"

type LinkedBundle = NonNullable<Artifact["linked_bundle"]>
export type LinkedBundleDiagram = NonNullable<LinkedBundle["diagrams"]>[number]
export type LinkedBundleDiagramNode = LinkedBundleDiagram["nodes"][number]
type WorkflowPreview = NonNullable<Artifact["workflow_preview"]>
export type LinkedBundleWorkflowNode = WorkflowPreview["diagrams"][number]["node_details"][number]

export type LinkedBundleNodeExplanation = {
  whatHappens: string | null
  source: "note" | "workflow" | null
  ownerContext: string | null
  expectedOutput: string | null
  exitCondition: string | null
}

/** Index workflow details once so every workspace view uses the same lookup. */
export const linkedBundleWorkflowNodeMap = (
  preview?: Artifact["workflow_preview"],
): Map<string, LinkedBundleWorkflowNode> => {
  const entries = (preview?.diagrams ?? []).flatMap((diagram) =>
    (diagram.node_details ?? []).map((node) => [`${diagram.id}:${node.node_id}`, node] as const),
  )
  return new Map(entries)
}

/** Join authored state with executable workflow detail. Notes take precedence;
 * workflow instruction and result keep older manifests understandable. */
export const linkedBundleNodeExplanation = (
  diagram: LinkedBundleDiagram,
  node: LinkedBundleDiagramNode,
  workflow?: LinkedBundleWorkflowNode,
): LinkedBundleNodeExplanation => {
  const whatHappens = node.note ?? workflow?.instruction ?? workflow?.result ?? null
  const workflowContext = workflow?.context_ref
    ? workflow.context_ref
    : workflow?.kind === "human"
      ? "Human decision"
      : workflow?.kind === "terminal"
        ? "Workflow"
        : null
  const ownerContext = [node.role, workflowContext].filter(Boolean).join(" · ") || null
  const labels = new Map(diagram.nodes.map((item) => [item.id, item.label]))
  const outgoing = diagram.edges.filter((edge) => edge.from === node.id)
  const authoredExit = outgoing.length
    ? outgoing
        .map((edge) =>
          edge.label
            ? `${edge.label} → ${labels.get(edge.to) ?? edge.to}`
            : `Continue → ${labels.get(edge.to) ?? edge.to}`,
        )
        .join("; ")
    : null

  return {
    whatHappens,
    source: node.note ? "note" : whatHappens ? "workflow" : null,
    ownerContext,
    expectedOutput: workflow?.result ?? null,
    exitCondition: workflow?.exit_condition ?? authoredExit,
  }
}
