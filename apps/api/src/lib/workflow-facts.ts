import {
  LINKED_BUNDLE_FACT,
  type LinkedBundleManifest,
  previewWorkflowJson,
  validateLinkedBundle,
  WORKFLOW_DEFINITION_FACT,
  type WorkflowPreview,
} from "@derive/core"

type FactRow = { slot: string; json: string }

export interface LinkedWorkflowFacts {
  bundleFound: boolean
  workflowFound: boolean
  manifest: LinkedBundleManifest | null
  bundleErrors: string[]
  preview?: WorkflowPreview
}

/** Parse the two authored workflow facts once for every API surface. This keeps
 * shared Preview and explicit Run on the same malformed-JSON and validation
 * behavior without coupling either route to document bytes. */
export const parseLinkedWorkflowFacts = (rows: FactRow[]): LinkedWorkflowFacts => {
  const bundleRow = rows.find((row) => row.slot === LINKED_BUNDLE_FACT)
  const workflowRow = rows.find((row) => row.slot === WORKFLOW_DEFINITION_FACT)
  if (!bundleRow)
    return {
      bundleFound: false,
      workflowFound: !!workflowRow,
      manifest: null,
      bundleErrors: [],
    }

  let checked: ReturnType<typeof validateLinkedBundle>
  try {
    checked = validateLinkedBundle(JSON.parse(bundleRow.json))
  } catch {
    return {
      bundleFound: true,
      workflowFound: !!workflowRow,
      manifest: null,
      bundleErrors: ["bundle-manifest is not valid JSON"],
    }
  }
  if (!checked.manifest)
    return {
      bundleFound: true,
      workflowFound: !!workflowRow,
      manifest: null,
      bundleErrors: checked.errors,
    }

  return {
    bundleFound: true,
    workflowFound: !!workflowRow,
    manifest: checked.manifest,
    bundleErrors: checked.errors,
    ...(workflowRow ? { preview: previewWorkflowJson(workflowRow.json, checked.manifest) } : {}),
  }
}
