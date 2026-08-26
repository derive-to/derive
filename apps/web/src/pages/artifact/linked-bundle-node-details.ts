import type { Artifact } from "@/api"

type LinkedBundle = NonNullable<Artifact["linked_bundle"]>
export type LinkedBundleDiagram = NonNullable<LinkedBundle["diagrams"]>[number]
export type LinkedBundleDiagramNode = LinkedBundleDiagram["nodes"][number]
type WorkflowPreview = NonNullable<Artifact["workflow_preview"]>
export type LinkedBundleWorkflowNode = WorkflowPreview["diagrams"][number]["node_details"][number]

export type LinkedBundleNodeNote = {
  text: string | null
  source: "note" | "workflow" | null
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

/** One plain-language note is the whole detail contract. A workflow description
 * seeds older nodes until an editor saves their own note. */
export const linkedBundleNodeNote = (
  node: LinkedBundleDiagramNode,
  workflow?: LinkedBundleWorkflowNode,
): LinkedBundleNodeNote => {
  const authored = node.note?.trim() || null
  const workflowDraft = workflow?.instruction?.trim() || workflow?.result?.trim() || null
  return authored
    ? { text: authored, source: "note" }
    : { text: workflowDraft, source: workflowDraft ? "workflow" : null }
}
