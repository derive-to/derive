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
import { toast } from "@/components/ui/sonner"
import { useApiMutation } from "@/lib/use-api-mutation"

// THE EXPERT DOOR — for someone who already has a manifest written (by hand, or by an
// agent that published one) and just wants to register it, no interview needed. Reached
// only through the builder page's "I already have a manifest" toggle; the guided
// conversation (builder.tsx) is the front door everyone else walks through.
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
  // The minted agent's bearer, shown exactly once; navigation waits for Done so
  // the only display of the token is never lost to an instant redirect.
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
      // Carry the user straight into the console they just made — asking the first
      // question is the point, not admiring a new row in the directory.
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
            <SelectTrigger data-testid="context-create-agent" aria-label="Agent" className="w-44">
              <SelectValue placeholder="Its own agent" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Its own agent (default)</SelectItem>
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
      {/* Shown exactly once, warning tone — same contract as agent registration. */}
      {minted && (
        <div data-testid="context-agent-token">
          <StatusPanel
            tone="warning"
            layout="inline"
            title={`Runner token for ${minted.name} — copy it now, it won't be shown again.`}
            description={
              <div className="flex flex-col gap-1.5">
                <code className="block break-all rounded-md bg-secondary px-2.5 py-1.5 font-mono text-2xs text-foreground">
                  {minted.token}
                </code>
                <span className="text-2xs text-muted-foreground">
                  Save it where the runner reads it (e.g.{" "}
                  <code className="font-mono">.derive/agent-token</code>), then{" "}
                  <code className="font-mono">derive runner serve</code> answers this context.
                </span>
              </div>
            }
            action={
              <div className="flex items-center gap-2">
                <Button
                  data-testid="context-agent-token-copy"
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    navigator.clipboard?.writeText(minted.token)
                    toast.success("Token copied")
                  }}
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
