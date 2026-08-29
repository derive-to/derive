import { useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import { api } from "@/api"
import { StatusPanel } from "@/components/shared/status-panel"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { copyText } from "@/lib/clipboard"
import { useApiMutation } from "@/lib/use-api-mutation"

// Advanced creation path for an instruction artifact that has already been published.
// The guided builder owns the default flow.
export function NewContextForm({
  agents,
  onCreated,
}: {
  agents: { id: string; name: string }[]
  onCreated: () => void
}) {
  const [name, setName] = useState("")
  // "" = auto-mint (the default; nobody picks an agent). A non-empty id = run as
  // an existing service agent — an opt-in the roster's presence (admins) reveals.
  const [agentId, setAgentId] = useState("")
  const [manifest, setManifest] = useState("")
  // Creating a dedicated connection may return a bearer once. Defer navigation until
  // the user dismisses the reveal.
  const [minted, setMinted] = useState<{ contextId: string; name: string; token: string } | null>(
    null,
  )
  const nav = useNavigate()

  const create = useApiMutation({
    mutationFn: () =>
      api.createContext({
        name: name.trim(),
        ...(agentId ? { agent_id: agentId } : {}),
        manifest_short_id: manifest.trim(),
      }),
    success: "Context created",
    onSuccess: (ctx) => {
      const created = name.trim()
      setName("")
      setManifest("")
      onCreated()
      if (ctx.agent_token) {
        setMinted({ contextId: ctx.id, name: created, token: ctx.agent_token })
        return
      }
      // Open the new Context directly when no credential reveal is required.
      nav({ to: "/contexts/$id", params: { id: ctx.id } })
    },
  })
  const submit = () => {
    if (name.trim() && manifest.trim()) create.mutate()
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-card p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          data-testid="context-create-name"
          aria-label="Context name"
          placeholder="Name (e.g. Analytics)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="min-w-40 flex-1"
        />
        <Input
          data-testid="context-create-manifest"
          aria-label="Manifest short id"
          placeholder="Manifest short id"
          value={manifest}
          onChange={(e) => setManifest(e.target.value)}
          className="w-44 font-mono"
        />
        {/* Only admins can even load the roster; everyone else auto-mints. */}
        {agents.length > 0 && (
          <Select value={agentId} onValueChange={(v) => setAgentId(v === "auto" ? "" : v)}>
            <SelectTrigger
              data-testid="context-create-agent"
              aria-label="Execution connection"
              className="w-44"
            >
              <SelectValue placeholder="Dedicated connection" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Dedicated connection (default)</SelectItem>
              {agents.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Button
          data-testid="context-create-submit"
          onClick={submit}
          loading={create.isPending}
          disabled={create.isPending || !name.trim() || !manifest.trim()}
        >
          Create
        </Button>
      </div>
      {/* Runner credentials are revealed once. */}
      {minted && (
        <div data-testid="context-agent-token">
          <StatusPanel
            tone="warning"
            layout="inline"
            title={`Copy the runner token for ${minted.name} now. It will not be shown again.`}
            description={
              <div className="flex flex-col gap-1.5">
                <code className="block break-all rounded-md bg-secondary px-2.5 py-1.5 font-mono text-2xs text-foreground">
                  {minted.token}
                </code>
                <span className="text-2xs text-muted-foreground">
                  Save it where the runner reads it (e.g.{" "}
                  <code className="font-mono">.derive/agent-token</code>), then{" "}
                  <code className="font-mono">derive runner serve</code> serves this Context.
                </span>
              </div>
            }
            action={
              <div className="flex items-center gap-2">
                <Button
                  data-testid="context-agent-token-copy"
                  variant="secondary"
                  size="sm"
                  onClick={() => void copyText(minted.token, { success: "Token copied" })}
                >
                  Copy
                </Button>
                <Button
                  data-testid="context-agent-token-done"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    const id = minted.contextId
                    setMinted(null)
                    nav({ to: "/contexts/$id", params: { id } })
                  }}
                >
                  Done
                </Button>
              </div>
            }
          />
        </div>
      )}
    </div>
  )
}
