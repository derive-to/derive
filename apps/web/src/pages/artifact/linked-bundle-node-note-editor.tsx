import { useState } from "react"
import { api } from "@/api"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { useApiMutation } from "@/lib/use-api-mutation"
import { linkedBundleManifestSource } from "./linked-bundle-editor"

export const linkedBundleNodeNoteEdit = (
  source: string,
  diagramId: string,
  nodeId: string,
  note: string,
): { exact: string; serialized: string } | null => {
  const manifest = linkedBundleManifestSource(source)
  if (!manifest) return null
  const diagrams = manifest.value.diagrams
  if (!Array.isArray(diagrams)) return null
  const diagram = diagrams.find(
    (item) => item && typeof item === "object" && (item as { id?: unknown }).id === diagramId,
  ) as { nodes?: unknown } | undefined
  if (!diagram || !Array.isArray(diagram.nodes)) return null
  const node = diagram.nodes.find(
    (item) => item && typeof item === "object" && (item as { id?: unknown }).id === nodeId,
  ) as Record<string, unknown> | undefined
  if (!node) return null

  const trimmed = note.trim()
  if (trimmed) node.note = trimmed
  else delete node.note
  return {
    exact: manifest.exact,
    serialized: JSON.stringify(manifest.value).replace(/</g, "\\u003c"),
  }
}

export function LinkedBundleNodeNoteEditor({
  shortId,
  version,
  diagramId,
  node,
  workflowDraft,
  onClose,
  onSaved,
}: {
  shortId: string
  version: number
  diagramId: string
  node: { id: string; label: string; note?: string }
  workflowDraft?: string | null
  onClose: () => void
  onSaved: () => void
}) {
  const [note, setNote] = useState(() => node.note ?? workflowDraft ?? "")
  const [problem, setProblem] = useState<string | null>(null)

  const changed = note.trim() !== (node.note ?? "").trim()
  const save = useApiMutation({
    mutationFn: async () => {
      const html = await api.getContent(shortId)
      const edit = linkedBundleNodeNoteEdit(html, diagramId, node.id, note)
      if (!edit) throw new Error("This node could not be found in the current manifest.")
      return api.publishEdits(
        shortId,
        [{ old_str: edit.exact, new_str: edit.serialized }],
        version,
        `Updated note for ${node.label}`,
      )
    },
    success: () => "Saved note",
    errorToast: false,
    onError: (error) => setProblem(error.message || "The note could not be saved."),
    onSuccess: () => {
      onClose()
      onSaved()
    },
  })

  return (
    <div
      className="mt-3 rounded-lg border border-border-soft bg-background/40 p-3"
      data-testid="bundle-note-editor"
    >
      <label className="grid gap-2">
        <span className="font-mono text-2xs uppercase tracking-[0.08em] text-muted-foreground">
          Note
        </span>
        <Textarea
          data-testid="bundle-note-input"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Describe what happens in this node"
          className="min-h-20 resize-y text-sm leading-relaxed"
          autoFocus
        />
      </label>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {!node.note && workflowDraft ? "Drafted from the workflow" : "Keep it short"}
        </p>
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="sm"
            data-testid="bundle-note-cancel"
            onClick={onClose}
            disabled={save.isPending}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            data-testid="bundle-note-save"
            onClick={() => {
              setProblem(null)
              save.mutate()
            }}
            disabled={save.isPending || !changed}
          >
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
      {problem ? (
        <div className="mt-2 text-xs text-destructive" role="alert">
          {problem}
        </div>
      ) : null}
    </div>
  )
}
