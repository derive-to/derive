import { useEffect, useMemo, useState } from "react"
import { api } from "@/api"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { useApiMutation } from "@/lib/use-api-mutation"

const MANIFEST_SCRIPT =
  /<script\b(?=[^>]*\btype\s*=\s*["']application\/derive-facts["'])(?=[^>]*\bdata-fact\s*=\s*["']bundle-manifest["'])[^>]*>([\s\S]*?)<\/script\s*>/i

export const linkedBundleManifestSource = (
  source: string,
): { exact: string; value: Record<string, unknown> } | null => {
  const match = MANIFEST_SCRIPT.exec(source)
  if (!match?.[1]) return null
  try {
    const value = JSON.parse(match[1])
    return value && typeof value === "object" && !Array.isArray(value)
      ? { exact: match[1], value: value as Record<string, unknown> }
      : null
  } catch {
    return null
  }
}

export const linkedBundleManifestProblem = (value: unknown): string | null => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return "Manifest must be an object."
  const manifest = value as Record<string, unknown>
  if (manifest.schema !== "derive.linked-bundle/v1")
    return 'Schema must be "derive.linked-bundle/v1".'
  if (typeof manifest.purpose !== "string" || !manifest.purpose.trim())
    return "Purpose is required."
  if (!Array.isArray(manifest.members)) return "Members must be an array."
  if (manifest.diagrams !== undefined && !Array.isArray(manifest.diagrams))
    return "Diagrams must be an array."
  if (manifest.members.length === 0 && (!manifest.diagrams || manifest.diagrams.length === 0))
    return "Add at least one artifact member, loop, or graph."
  return null
}

export type LinkedBundleManifestSummary = {
  artifacts: number
  loops: number
  graphs: number
  nodes: number
  relationships: number
}

export const linkedBundleManifestSummary = (value: unknown): LinkedBundleManifestSummary => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { artifacts: 0, loops: 0, graphs: 0, nodes: 0, relationships: 0 }
  const manifest = value as Record<string, unknown>
  const diagrams = Array.isArray(manifest.diagrams)
    ? manifest.diagrams.filter(
        (diagram): diagram is Record<string, unknown> =>
          !!diagram && typeof diagram === "object" && !Array.isArray(diagram),
      )
    : []
  return {
    artifacts: Array.isArray(manifest.members) ? manifest.members.length : 0,
    loops: diagrams.filter((diagram) => diagram.type === "loop").length,
    graphs: diagrams.filter((diagram) => diagram.type === "graph").length,
    nodes: diagrams.reduce(
      (count, diagram) => count + (Array.isArray(diagram.nodes) ? diagram.nodes.length : 0),
      0,
    ),
    relationships: diagrams.reduce(
      (count, diagram) => count + (Array.isArray(diagram.edges) ? diagram.edges.length : 0),
      0,
    ),
  }
}

export function LinkedBundleEditor({
  shortId,
  version,
  open,
  onOpenChange,
  onSaved,
}: {
  shortId: string
  version: number
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}) {
  const [source, setSource] = useState("")
  const [initialSource, setInitialSource] = useState("")
  const [exact, setExact] = useState("")
  const [loading, setLoading] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let current = true
    setLoading(true)
    setProblem(null)
    api
      .getContent(shortId)
      .then((html) => {
        if (!current) return
        const manifest = linkedBundleManifestSource(html)
        if (!manifest) {
          setProblem("The current bundle manifest could not be read.")
          return
        }
        setExact(manifest.exact)
        const formatted = JSON.stringify(manifest.value, null, 2)
        setSource(formatted)
        setInitialSource(formatted)
      })
      .catch(() => {
        if (current) setProblem("The current bundle source could not be loaded.")
      })
      .finally(() => {
        if (current) setLoading(false)
      })
    return () => {
      current = false
    }
  }, [open, shortId])

  const inspection = useMemo(() => {
    try {
      const value = JSON.parse(source) as unknown
      return {
        value,
        problem: linkedBundleManifestProblem(value),
        summary: linkedBundleManifestSummary(value),
      }
    } catch {
      return {
        value: null,
        problem: "Manifest must be valid JSON.",
        summary: linkedBundleManifestSummary(null),
      }
    }
  }, [source])
  const dirty = source !== initialSource

  const save = useApiMutation({
    mutationFn: async (next: string) => {
      const parsed = JSON.parse(next) as unknown
      const invalid = linkedBundleManifestProblem(parsed)
      if (invalid) throw new Error(invalid)
      const serialized = JSON.stringify(parsed).replace(/</g, "\\u003c")
      return api.publishEdits(
        shortId,
        [{ old_str: exact, new_str: serialized }],
        version,
        "Updated linked bundle manifest",
      )
    },
    success: (artifact) => `Saved bundle v${artifact.current_version}`,
    errorToast: false,
    onError: (error) => setProblem(error.message || "The manifest could not be saved."),
    onSuccess: () => {
      onOpenChange(false)
      onSaved()
    },
  })

  const submit = () => {
    setProblem(null)
    if (inspection.problem) {
      setProblem(inspection.problem)
      return
    }
    save.mutate(source)
  }

  const stats = [
    ["Artifacts", inspection.summary.artifacts],
    ["Loops", inspection.summary.loops],
    ["Graphs", inspection.summary.graphs],
    ["Nodes", inspection.summary.nodes],
    ["Relationships", inspection.summary.relationships],
  ] as const

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="gap-0 overflow-hidden p-0 sm:max-w-4xl"
        aria-describedby="bundle-editor-description"
      >
        <DialogHeader>
          <DialogTitle className="px-6 pt-6">Edit loop / graph manifest</DialogTitle>
          <DialogDescription id="bundle-editor-description">
            <span className="block px-6 pb-5">
              The visible contract agents and the native workspace read. Explicit JSON stays the
              escape hatch; Derive does not execute it.
            </span>
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-5 border-y border-border bg-muted/20">
          {stats.map(([label, value], index) => (
            <div key={label} className={index ? "border-l border-border px-4 py-3" : "px-4 py-3"}>
              <div className="font-mono text-2xs uppercase tracking-[0.1em] text-muted-foreground">
                {label}
              </div>
              <div className="mt-1 text-lg font-semibold text-foreground">
                {loading || inspection.problem ? "—" : value}
              </div>
            </div>
          ))}
        </div>
        <div className="px-6 pt-5">
          <div className="flex items-center justify-between rounded-t-lg border border-border bg-muted/30 px-3 py-2">
            <div className="flex items-center gap-2 font-mono text-2xs uppercase tracking-[0.1em] text-muted-foreground">
              JSON source
              <span className={dirty ? "text-warning" : "text-success"}>
                {dirty ? "Unsaved changes" : `Current v${version}`}
              </span>
            </div>
            <Button
              variant="ghost"
              size="sm"
              data-testid="bundle-manifest-format"
              disabled={loading || save.isPending || !!inspection.problem}
              onClick={() => setSource(JSON.stringify(inspection.value, null, 2))}
            >
              Format JSON
            </Button>
          </div>
          <Textarea
            data-testid="bundle-manifest-source"
            value={source}
            onChange={(event) => {
              setSource(event.target.value)
              setProblem(null)
            }}
            disabled={loading || save.isPending}
            spellCheck={false}
            className="min-h-[26rem] resize-y rounded-t-none border-t-0 font-mono text-xs leading-relaxed"
            aria-label="Linked bundle manifest JSON"
          />
          <div className="flex items-center justify-between px-1 py-2 font-mono text-2xs text-muted-foreground">
            <span className={inspection.problem ? "text-destructive" : "text-success"}>
              {loading ? "Loading manifest…" : (inspection.problem ?? "Manifest valid")}
            </span>
            <span>{new Blob([source]).size.toLocaleString()} bytes</span>
          </div>
        </div>
        {problem ? (
          <div
            role="alert"
            className="mx-6 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
          >
            {problem}
          </div>
        ) : null}
        <DialogFooter className="mt-3 border-t border-border bg-muted/20 px-6 py-4 sm:items-center sm:justify-between">
          <span className="text-left text-xs text-muted-foreground">
            Saving publishes bundle v{version + 1}. Nothing runs.
          </span>
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              data-testid="bundle-manifest-cancel"
              onClick={() => onOpenChange(false)}
              disabled={save.isPending}
            >
              Cancel
            </Button>
            <Button
              data-testid="bundle-manifest-save"
              onClick={submit}
              disabled={loading || save.isPending || !exact || !dirty || !!inspection.problem}
            >
              {save.isPending ? "Saving…" : `Save v${version + 1}`}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
