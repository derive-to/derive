import { useEffect, useMemo, useState } from "react"
import { api } from "@/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useApiMutation } from "@/lib/use-api-mutation"
import { linkedBundleManifestSource } from "./linked-bundle-editor"

type NodeState = "pending" | "active" | "blocked" | "done"

export type LinkedBundleReconciliation = {
  state: NodeState
  basisVersion?: number
  note?: string
}

export const linkedBundleReconciliationEdit = (
  source: string,
  diagramId: string,
  nodeId: string,
  next: LinkedBundleReconciliation,
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

  node.state = next.state
  if (next.basisVersion) node.basis_version = next.basisVersion
  else delete node.basis_version
  const note = next.note?.trim()
  if (note) node.note = note
  else delete node.note
  return {
    exact: manifest.exact,
    serialized: JSON.stringify(manifest.value).replace(/</g, "\\u003c"),
  }
}

export function LinkedBundleReconcile({
  shortId,
  version,
  diagramId,
  node,
  memberVersion,
  onClose,
  onSaved,
  onEditManifest,
}: {
  shortId: string
  version: number
  diagramId: string
  node: { id: string; label: string; state?: NodeState; basis_version?: number; note?: string }
  memberVersion?: number
  onClose: () => void
  onSaved: () => void
  onEditManifest: () => void
}) {
  const [state, setState] = useState<NodeState>(node.state ?? "pending")
  const [basisVersion, setBasisVersion] = useState(node.basis_version?.toString() ?? "")
  const [note, setNote] = useState(node.note ?? "")
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    setState(node.state ?? "pending")
    setBasisVersion(node.basis_version?.toString() ?? "")
    setNote(node.note ?? "")
    setProblem(null)
  }, [node])

  const next = useMemo<LinkedBundleReconciliation>(
    () => ({
      state,
      basisVersion: basisVersion ? Number(basisVersion) : undefined,
      note,
    }),
    [basisVersion, note, state],
  )
  const changes = [
    state !== (node.state ?? "pending") ? `${node.state ?? "pending"} → ${state}` : null,
    next.basisVersion !== node.basis_version
      ? `basis ${node.basis_version ? `v${node.basis_version}` : "unset"} → ${next.basisVersion ? `v${next.basisVersion}` : "unset"}`
      : null,
    note.trim() !== (node.note ?? "").trim() ? "note updated" : null,
  ].filter(Boolean)

  const save = useApiMutation({
    mutationFn: async () => {
      const html = await api.getContent(shortId)
      const edit = linkedBundleReconciliationEdit(html, diagramId, node.id, next)
      if (!edit) throw new Error("This node could not be found in the current manifest.")
      return api.publishEdits(
        shortId,
        [{ old_str: edit.exact, new_str: edit.serialized }],
        version,
        `Reconciled ${node.label}`,
      )
    },
    success: (artifact) => `Saved bundle v${artifact.current_version}`,
    errorToast: false,
    onError: (error) => setProblem(error.message || "The state could not be saved."),
    onSuccess: () => {
      onSaved()
    },
  })

  return (
    <div
      className="mt-4 rounded-xl border border-border bg-muted/20 p-3"
      data-testid="bundle-reconcile-panel"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="text-sm font-medium text-foreground">Update authored state</div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Explicit values only. Saving creates bundle v{version + 1}; no runtime is inferred.
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          data-testid="bundle-reconcile-full-manifest"
          onClick={onEditManifest}
        >
          Full manifest
        </Button>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-[11rem_10rem_minmax(14rem,1fr)]">
        <div className="grid gap-1 text-xs text-muted-foreground">
          <span>State</span>
          <Select value={state} onValueChange={(value) => setState(value as NodeState)}>
            <SelectTrigger
              data-testid="bundle-reconcile-state"
              className="w-full"
              aria-label="Authored node state"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(["pending", "active", "blocked", "done"] as const).map((value) => (
                <SelectItem key={value} value={value}>
                  <span className="capitalize">{value}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <label className="grid gap-1 text-xs text-muted-foreground">
          Artifact basis
          <Input
            data-testid="bundle-reconcile-basis"
            type="number"
            min={1}
            value={basisVersion}
            onChange={(event) => setBasisVersion(event.target.value)}
            aria-label="Artifact basis version"
          />
        </label>
        <label className="grid gap-1 text-xs text-muted-foreground">
          Reviewer note
          <Input
            data-testid="bundle-reconcile-note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Why this state is correct"
          />
        </label>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {memberVersion ? (
            <Button
              variant="outline"
              size="sm"
              data-testid="bundle-reconcile-use-current"
              onClick={() => setBasisVersion(memberVersion.toString())}
            >
              Use current v{memberVersion}
            </Button>
          ) : null}
          <span data-testid="bundle-reconcile-preview">
            {changes.length ? changes.join(" · ") : "No authored changes yet"}
          </span>
        </div>
        <div className="flex gap-2">
          <Button
            variant="ghost"
            size="sm"
            data-testid="bundle-reconcile-cancel"
            onClick={onClose}
            disabled={save.isPending}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            data-testid="bundle-reconcile-save"
            onClick={() => {
              setProblem(null)
              save.mutate()
            }}
            disabled={save.isPending || changes.length === 0}
          >
            {save.isPending ? "Saving…" : `Save v${version + 1}`}
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
