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

type NodeState = "pending" | "active" | "waiting" | "blocked" | "done"
type ConfidenceLevel = "low" | "medium" | "high"
type HelpStatus = "unset" | "needed" | "not-needed"

export type LinkedBundleReconciliation = {
  state?: NodeState
  basisVersion?: number
  note?: string
  role?: string
  confidence?: { level: ConfidenceLevel; basis: string }
  help?: { needed: boolean; question?: string; canContinue?: string }
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

  if (next.state) node.state = next.state
  else delete node.state
  if (next.basisVersion) node.basis_version = next.basisVersion
  else delete node.basis_version
  const note = next.note?.trim()
  if (note) node.note = note
  else delete node.note
  const role = next.role?.trim()
  if (role) node.role = role
  else delete node.role
  if (next.confidence) {
    node.confidence = {
      level: next.confidence.level,
      basis: next.confidence.basis.trim(),
    }
  } else delete node.confidence
  if (next.help) {
    const question = next.help.question?.trim()
    const canContinue = next.help.canContinue?.trim()
    node.help = {
      needed: next.help.needed,
      ...(question ? { question } : {}),
      ...(canContinue ? { can_continue: canContinue } : {}),
    }
  } else delete node.help
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
  node: {
    id: string
    label: string
    state?: NodeState
    basis_version?: number
    note?: string
    role?: string
    confidence?: { level: ConfidenceLevel; basis: string }
    help?: { needed: boolean; question?: string; can_continue?: string }
  }
  memberVersion?: number
  onClose: () => void
  onSaved: () => void
  onEditManifest: () => void
}) {
  const [state, setState] = useState<NodeState | "unset">(node.state ?? "unset")
  const [basisVersion, setBasisVersion] = useState(node.basis_version?.toString() ?? "")
  const [note, setNote] = useState(node.note ?? "")
  const [role, setRole] = useState(node.role ?? "")
  const [confidenceLevel, setConfidenceLevel] = useState<ConfidenceLevel | "unset">(
    node.confidence?.level ?? "unset",
  )
  const [confidenceBasis, setConfidenceBasis] = useState(node.confidence?.basis ?? "")
  const [helpStatus, setHelpStatus] = useState<HelpStatus>(
    node.help ? (node.help.needed ? "needed" : "not-needed") : "unset",
  )
  const [helpQuestion, setHelpQuestion] = useState(node.help?.question ?? "")
  const [canContinue, setCanContinue] = useState(node.help?.can_continue ?? "")
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    setState(node.state ?? "unset")
    setBasisVersion(node.basis_version?.toString() ?? "")
    setNote(node.note ?? "")
    setRole(node.role ?? "")
    setConfidenceLevel(node.confidence?.level ?? "unset")
    setConfidenceBasis(node.confidence?.basis ?? "")
    setHelpStatus(node.help ? (node.help.needed ? "needed" : "not-needed") : "unset")
    setHelpQuestion(node.help?.question ?? "")
    setCanContinue(node.help?.can_continue ?? "")
    setProblem(null)
  }, [node])

  const next = useMemo<LinkedBundleReconciliation>(
    () => ({
      state: state === "unset" ? undefined : state,
      basisVersion: basisVersion ? Number(basisVersion) : undefined,
      note,
      role,
      confidence:
        confidenceLevel === "unset"
          ? undefined
          : { level: confidenceLevel, basis: confidenceBasis },
      help:
        helpStatus === "unset"
          ? undefined
          : helpStatus === "needed"
            ? { needed: true, question: helpQuestion, canContinue }
            : { needed: false },
    }),
    [
      basisVersion,
      canContinue,
      confidenceBasis,
      confidenceLevel,
      helpQuestion,
      helpStatus,
      note,
      role,
      state,
    ],
  )
  const confidenceChanged =
    next.confidence?.level !== node.confidence?.level ||
    next.confidence?.basis.trim() !== node.confidence?.basis.trim()
  const helpChanged =
    next.help?.needed !== node.help?.needed ||
    next.help?.question?.trim() !== node.help?.question?.trim() ||
    next.help?.canContinue?.trim() !== node.help?.can_continue?.trim()
  const changes = [
    next.state !== node.state
      ? `${node.state ?? "not stated"} → ${next.state ?? "not stated"}`
      : null,
    next.basisVersion !== node.basis_version
      ? `basis ${node.basis_version ? `v${node.basis_version}` : "unset"} → ${next.basisVersion ? `v${next.basisVersion}` : "unset"}`
      : null,
    note.trim() !== (node.note ?? "").trim() ? "note updated" : null,
    role.trim() !== (node.role ?? "").trim() ? "role updated" : null,
    confidenceChanged ? "confidence updated" : null,
    helpChanged ? "help details updated" : null,
  ].filter(Boolean)

  const save = useApiMutation({
    mutationFn: async () => {
      if (next.confidence && !next.confidence.basis.trim())
        throw new Error("Add a confidence basis, or set confidence to Not stated.")
      if (next.help?.needed && !next.help.question?.trim())
        throw new Error("Add the help question, or set help to Not stated.")
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
          <div className="text-sm font-medium text-foreground">Update node details</div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Every field is optional. Saving creates bundle v{version + 1}; no runtime is inferred.
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
          <Select value={state} onValueChange={(value) => setState(value as NodeState | "unset")}>
            <SelectTrigger
              data-testid="bundle-reconcile-state"
              className="w-full"
              aria-label="Authored node state"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="unset">Not stated</SelectItem>
              {(["pending", "active", "waiting", "blocked", "done"] as const).map((value) => (
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
      <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(12rem,1fr)_minmax(16rem,1.4fr)]">
        <label className="grid gap-1 text-xs text-muted-foreground">
          Role
          <Input
            data-testid="bundle-reconcile-role"
            value={role}
            onChange={(event) => setRole(event.target.value)}
            placeholder="Optional responsibility"
          />
        </label>
        <div className="grid gap-1 text-xs text-muted-foreground">
          <span>Confidence</span>
          <div className="grid gap-2 sm:grid-cols-[9rem_minmax(0,1fr)]">
            <Select
              value={confidenceLevel}
              onValueChange={(value) => setConfidenceLevel(value as ConfidenceLevel | "unset")}
            >
              <SelectTrigger
                data-testid="bundle-reconcile-confidence-level"
                className="w-full"
                aria-label="Confidence level"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="unset">Not stated</SelectItem>
                {(["low", "medium", "high"] as const).map((value) => (
                  <SelectItem key={value} value={value}>
                    <span className="capitalize">{value}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              data-testid="bundle-reconcile-confidence-basis"
              value={confidenceBasis}
              onChange={(event) => setConfidenceBasis(event.target.value)}
              placeholder="Why this confidence level"
              aria-label="Confidence basis"
              disabled={confidenceLevel === "unset"}
            />
          </div>
        </div>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-[11rem_minmax(12rem,1fr)_minmax(12rem,1fr)]">
        <div className="grid gap-1 text-xs text-muted-foreground">
          <span>Help status</span>
          <Select value={helpStatus} onValueChange={(value) => setHelpStatus(value as HelpStatus)}>
            <SelectTrigger
              data-testid="bundle-reconcile-help-status"
              className="w-full"
              aria-label="Help status"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="unset">Not stated</SelectItem>
              <SelectItem value="needed">Needs help</SelectItem>
              <SelectItem value="not-needed">No help needed</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <label className="grid gap-1 text-xs text-muted-foreground">
          Help question
          <Input
            data-testid="bundle-reconcile-help-question"
            value={helpQuestion}
            onChange={(event) => setHelpQuestion(event.target.value)}
            placeholder="What decision is needed?"
            disabled={helpStatus !== "needed"}
          />
        </label>
        <label className="grid gap-1 text-xs text-muted-foreground">
          Can continue
          <Input
            data-testid="bundle-reconcile-can-continue"
            value={canContinue}
            onChange={(event) => setCanContinue(event.target.value)}
            placeholder="Work that can continue"
            disabled={helpStatus !== "needed"}
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
