import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { api, type ModelCredentialHint } from "@/api"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { EmptyState } from "@/components/shared/empty-state"
import { SettingsGroup } from "@/components/shared/settings-group"
import { StatusPanel } from "@/components/shared/status-panel"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { modelCredentialsQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import { SettingsListSkeleton } from "./settings-list-skeleton"
import { SettingsSection } from "./settings-section"

type Provider = "claude-code" | "codex"

const PROVIDERS: { id: Provider; label: string; how: string }[] = [
  {
    id: "claude-code",
    label: "Claude",
    how: "Run `claude setup-token` on any machine (it opens a browser) and paste the token it prints.",
  },
  {
    id: "codex",
    label: "Codex",
    how: "Paste an OpenAI API key. (A ChatGPT-plan login is coming; API keys work today.)",
  },
]
const providerLabel = (id: string) => PROVIDERS.find((p) => p.id === id)?.label ?? id

// Personal "Model plans": connect your OWN Claude/Codex plan (or API key). It is encrypted
// and used ONLY for your own agent runs — never shared. This is what lets your work run on
// hosted Derive without a machine of your own.
export function ModelPlansSection() {
  const qc = useQueryClient()
  const { data: creds, isPending, isError, refetch } = useQuery(modelCredentialsQuery())
  const reload = () => qc.invalidateQueries({ queryKey: modelCredentialsQuery().queryKey })

  return (
    <SettingsSection
      title="Model plans"
      description={
        <>
          Connect your own model plan so your agents run on it. Your token is encrypted and used
          only for your own runs, never shared with anyone else on the team.
        </>
      }
    >
      <div className="rounded-lg border bg-card p-4">
        <ConnectForm onConnected={reload} />
      </div>

      {isPending ? (
        <SettingsListSkeleton />
      ) : isError ? (
        <StatusPanel
          tone="danger"
          title="Couldn't load your plans"
          description="This is usually temporary."
          action={
            <Button
              variant="outline"
              size="sm"
              data-testid="model-plans-retry"
              onClick={() => refetch()}
            >
              Try again
            </Button>
          }
        />
      ) : !creds || creds.length === 0 ? (
        <EmptyState>No plan connected yet. Connect one above to run on your own plan.</EmptyState>
      ) : (
        <SettingsGroup>
          {creds.map((c) => (
            <CredentialRow key={c.provider} cred={c} onDone={reload} />
          ))}
        </SettingsGroup>
      )}
    </SettingsSection>
  )
}

function ConnectForm({ onConnected }: { onConnected: () => void }) {
  const [provider, setProvider] = useState<Provider>("claude-code")
  const [kind, setKind] = useState<"oauth" | "api_key">("oauth")
  const [token, setToken] = useState("")
  const how = PROVIDERS.find((p) => p.id === provider)?.how ?? ""

  const connect = useApiMutation({
    mutationFn: () => api.connectModelCredential({ provider, kind, token: token.trim() }),
    success: "Plan connected",
    onSuccess: () => {
      setToken("")
      onConnected()
    },
  })
  const ready = token.trim() !== ""

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <Select value={provider} onValueChange={(v) => setProvider(v as Provider)}>
          <SelectTrigger data-testid="model-plan-provider" aria-label="Provider" className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PROVIDERS.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={kind} onValueChange={(v) => setKind(v as "oauth" | "api_key")}>
          <SelectTrigger
            data-testid="model-plan-kind"
            aria-label="Credential type"
            className="w-44"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="oauth">Plan token</SelectItem>
            <SelectItem value="api_key">API key</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <Input
        data-testid="model-plan-token"
        type="password"
        aria-label="Plan token or API key"
        placeholder="Paste your token"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && ready && connect.mutate()}
      />
      <p className="text-2xs text-muted-foreground">{how}</p>
      <div className="flex justify-end">
        <Button
          data-testid="model-plan-connect"
          variant="secondary"
          size="sm"
          onClick={() => ready && connect.mutate()}
          loading={connect.isPending}
          disabled={connect.isPending || !ready}
        >
          {connect.isPending ? "Connecting…" : "Connect"}
        </Button>
      </div>
    </div>
  )
}

function CredentialRow({ cred, onDone }: { cred: ModelCredentialHint; onDone: () => void }) {
  const [confirming, setConfirming] = useState(false)
  const remove = useApiMutation({
    mutationFn: () => api.disconnectModelCredential(cred.provider),
    success: "Plan disconnected",
    onSuccess: () => onDone(),
  })
  return (
    <div
      data-testid={`model-plan-row-${cred.provider}`}
      className="flex items-center gap-3 py-3 text-sm"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 font-medium text-foreground">
          {providerLabel(cred.provider)}
          <Badge variant="outline">{cred.kind === "oauth" ? "Plan token" : "API key"}</Badge>
        </div>
        <div className="font-mono text-2xs text-muted-foreground">connected · ••••{cred.hint}</div>
      </div>
      <Button
        data-testid={`model-plan-disconnect-${cred.provider}`}
        variant="destructive-ghost"
        size="sm"
        onClick={() => setConfirming(true)}
      >
        Disconnect
      </Button>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Disconnect this plan?"
        description="Your agents will stop running on it until you reconnect."
        confirmLabel="Disconnect"
        onConfirm={() => remove.mutate()}
      />
    </div>
  )
}
