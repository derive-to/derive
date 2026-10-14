import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import type { AgentDetail, AgentPatch } from "@/api"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { githubRepositoriesQuery } from "@/lib/queries"
import { Field, Sub } from "./rows"

// The repository an agent's tasks check out when the ask names none, so someone who only uses
// Derive can ask for code work without knowing where the code lives.

const NONE = "none"

export function RepositoryField({
  agent,
  edit,
  onSave,
}: {
  agent: AgentDetail
  edit: boolean
  onSave: (patch: AgentPatch) => void
}) {
  const github = agent.sources.find((s) => s.kind === "github_app" && s.status === "active")
  const current = agent.repository ?? null
  return (
    <Field label="Repository">
      {!edit ? (
        current ? (
          <span className="font-mono text-sm">{current}</span>
        ) : (
          <span className="text-muted-foreground">None</span>
        )
      ) : github ? (
        <RepositoryPicker
          sourceId={github.id}
          current={current}
          onPick={(repository) => onSave({ repository })}
        />
      ) : (
        <span className="text-muted-foreground">None</span>
      )}
      <Sub>
        {edit && !github
          ? "Add a GitHub source above to choose the repository its tasks work in."
          : "Tasks check it out when an ask names no other repository."}
      </Sub>
    </Field>
  )
}

function RepositoryPicker({
  sourceId,
  current,
  onPick,
}: {
  sourceId: string
  current: string | null
  onPick: (repository: string | null) => void
}) {
  // surface-ignore: suggestions only; without them the repository is typed instead.
  const repos = useQuery(githubRepositoriesQuery(sourceId, 1))
  const [typed, setTyped] = useState(current ?? "")
  const names = repos.data?.repositories.map((r) => r.full_name) ?? []
  if (!names.length)
    return (
      <Input
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        onBlur={() => {
          const next = typed.trim() || null
          if (next !== current) onPick(next)
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur()
        }}
        placeholder="owner/repository"
        aria-label="Repository"
        data-testid="agent-repository"
        className="w-72 font-mono"
      />
    )
  return (
    <Select value={current ?? NONE} onValueChange={(v) => onPick(v === NONE ? null : v)}>
      <SelectTrigger data-testid="agent-repository" aria-label="Repository" className="min-w-56">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>None</SelectItem>
        <SelectSeparator />
        {[...new Set([...(current ? [current] : []), ...names])].map((n) => (
          <SelectItem key={n} value={n} className="font-mono text-sm">
            {n}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
