import { useState } from "react"
import type { MergeConflict } from "@/api"
import { Icon } from "@/components/icons"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { allResolved, type Choice, conflictProgress, reassembleMerge } from "./lib/merge-reassemble"

/**
 * In-flow resolver for the rare case a publish couldn't auto-merge. The clean
 * path never reaches here: the server 3-way merges disjoint edits silently and
 * the version just advances. This shows only when your edit and a version landed
 * since you started editing changed the SAME region. Each clashing section offers
 * "Use current" (keep what's live), "Use mine" (your edit), or "Edit" (hand-write
 * it); untouched sections are shown dimmed for context. Resolving every section
 * enables "Publish merged version", which republishes against the live version —
 * so if no one slipped in again, it goes straight live. Renders in the document
 * column like the editor (NOT a fullscreen overlay), so comments stay alongside.
 */
export function ConflictResolver({
  conflict,
  format,
  editBase,
  busy,
  onResolve,
  onCancel,
}: {
  conflict: MergeConflict
  format: "md" | "html"
  editBase: number | null
  busy?: boolean
  // Reassembled document + the version to republish against (the live one).
  onResolve: (merged: string, baseVersion: number) => void
  onCancel: () => void
}) {
  const [choices, setChoices] = useState<Record<number, Choice>>({})
  const { total, resolved } = conflictProgress(conflict.conflicts, choices)
  const ready = allResolved(conflict.conflicts, choices)
  const pick = (i: number, c: Choice) => setChoices((p) => ({ ...p, [i]: c }))

  const publish = () => {
    if (!ready || busy) return
    onResolve(reassembleMerge(conflict.conflicts, choices, format), conflict.current_version)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-card">
      <div className="flex flex-wrap items-center gap-2 border-b border-border-soft px-4 py-2.5">
        <span className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
          <Icon name="edit" size={16} />
          <span>
            Resolve changes{editBase != null ? ` since v${editBase}` : ""} → v
            {conflict.current_version}
          </span>
        </span>
        <Badge variant={ready ? "success" : "accent"} size="md" className="ml-1">
          {resolved} of {total} resolved
        </Badge>
        <span className="ml-auto flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            data-testid="conflict-cancel"
            disabled={busy}
            onClick={onCancel}
          >
            Back to editing
          </Button>
          <Button
            variant="primary"
            size="sm"
            data-testid="conflict-publish"
            disabled={!ready || busy}
            onClick={publish}
          >
            {busy ? "Publishing…" : "Publish merged version"}
          </Button>
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-4 py-4">
        <p className="mb-4 max-w-prose text-sm text-muted-foreground">
          This document advanced to v{conflict.current_version} while you were editing. Disjoint
          changes were merged for you. The sections below were edited on both sides, so pick how
          each should read.
        </p>
        <div className="flex flex-col gap-3">
          {conflict.conflicts.map((h, i) =>
            h.t === "clean" ? (
              h.text.trim() ? (
                <pre
                  // biome-ignore lint/suspicious/noArrayIndexKey: hunks are an immutable, never-reordered decomposition rebuilt wholesale per conflict response.
                  key={i}
                  className="m-0 whitespace-pre-wrap break-words rounded-md bg-secondary/40 px-3 py-2 font-mono text-xs leading-relaxed text-muted-foreground"
                >
                  {h.text}
                </pre>
              ) : null
            ) : (
              <ConflictCard
                // biome-ignore lint/suspicious/noArrayIndexKey: see above.
                key={i}
                ours={h.ours}
                theirs={h.theirs}
                currentVersion={conflict.current_version}
                choice={choices[i]}
                onPick={(c) => pick(i, c)}
              />
            ),
          )}
        </div>
      </div>
    </div>
  )
}

function ConflictCard({
  ours,
  theirs,
  currentVersion,
  choice,
  onPick,
}: {
  ours: string
  theirs: string
  currentVersion: number
  choice: Choice | undefined
  onPick: (c: Choice) => void
}) {
  const selected = choice?.pick
  return (
    <div
      data-testid="conflict-card"
      className={cn("rounded-lg border bg-card", selected ? "border-primary" : "border-border")}
    >
      <div className="grid gap-px bg-border-soft md:grid-cols-2">
        <Side label={`Current · v${currentVersion}`} text={ours} active={selected === "ours"} />
        <Side label="Your edit" text={theirs} active={selected === "theirs"} accent />
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-border-soft px-3 py-2">
        <Button
          variant={selected === "ours" ? "primary" : "outline"}
          size="sm"
          data-testid="conflict-use-current"
          onClick={() => onPick({ pick: "ours" })}
        >
          Use current
        </Button>
        <Button
          variant={selected === "theirs" ? "primary" : "outline"}
          size="sm"
          data-testid="conflict-use-mine"
          onClick={() => onPick({ pick: "theirs" })}
        >
          Use mine
        </Button>
        <Button
          variant={selected === "edit" ? "primary" : "outline"}
          size="sm"
          data-testid="conflict-edit"
          onClick={() =>
            onPick({ pick: "edit", text: choice?.pick === "edit" ? choice.text : theirs })
          }
        >
          Edit
        </Button>
      </div>
      {choice?.pick === "edit" && (
        <textarea
          value={choice.text}
          onChange={(e) => onPick({ pick: "edit", text: e.target.value })}
          spellCheck={false}
          aria-label="Hand-merged text"
          data-testid="conflict-edit-text"
          className="block w-full resize-y border-t border-border-soft bg-card px-3 py-2 font-mono text-xs leading-relaxed text-foreground outline-none"
          rows={Math.min(12, Math.max(3, choice.text.split("\n").length + 1))}
        />
      )}
    </div>
  )
}

function Side({
  label,
  text,
  active,
  accent,
}: {
  label: string
  text: string
  active: boolean
  accent?: boolean
}) {
  return (
    <div className={cn("bg-card", active && (accent ? "bg-primary/5" : "bg-secondary/50"))}>
      <div
        className={cn(
          "px-3 pt-2 text-2xs font-semibold uppercase tracking-wide",
          accent ? "text-primary" : "text-muted-foreground",
        )}
      >
        {label}
      </div>
      <pre className="m-0 max-h-64 overflow-auto whitespace-pre-wrap break-words px-3 pb-2 pt-1 font-mono text-xs leading-relaxed text-foreground">
        {text.trim() ? text : <span className="italic text-muted-foreground">(removed)</span>}
      </pre>
    </div>
  )
}
