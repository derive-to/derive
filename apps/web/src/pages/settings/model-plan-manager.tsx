import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { api, type ModelCredentialHint } from "@/api"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { ListRow } from "@/components/shared/list-row"
import { LoadError } from "@/components/shared/load-error"
import { SettingsGroup } from "@/components/shared/settings-group"
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
import { Textarea } from "@/components/ui/textarea"
import { modelCredentialsQuery, poolCredentialsQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import { SettingsListSkeleton } from "./settings-list-skeleton"

type Provider = "claude-code" | "codex"
type Kind = "oauth" | "api_key" | "login"
type Scope = "personal" | "pool"

type KindSpec = { id: Kind; label: string; how: string; multiline?: boolean }
type ProviderCfg = { id: Provider; label: string; kinds: [KindSpec, ...KindSpec[]] }
// Each provider offers its own credential kinds. A PLAN (subscription) is the headline for
// both: Claude via a setup-token (env var), Codex via a login file. API keys are the fallback.
// Non-empty tuples so the [0] defaults below are always defined.
const PROVIDERS: [ProviderCfg, ...ProviderCfg[]] = [
  {
    id: "claude-code",
    label: "Claude",
    kinds: [
      {
        id: "oauth",
        label: "Plan (subscription)",
        how: "Run `claude setup-token` on any machine (it opens a browser) and paste the token it prints.",
      },
      { id: "api_key", label: "API key", how: "Paste an Anthropic API key (sk-ant-…)." },
    ],
  },
  {
    id: "codex",
    label: "Codex",
    kinds: [
      {
        id: "login",
        label: "Plan (subscription)",
        multiline: true,
        how: "Run `codex login` on any machine, then paste the contents of ~/.codex/auth.json here.",
      },
      { id: "api_key", label: "API key", how: "Paste an OpenAI API key (sk-…)." },
    ],
  },
]
const providerLabel = (id: string) => PROVIDERS.find((p) => p.id === id)?.label ?? id
const kindLabel = (provider: string, kind: string) =>
  PROVIDERS.find((p) => p.id === provider)?.kinds.find((k) => k.id === kind)?.label ??
  (kind === "api_key" ? "API key" : "Plan")

// The connect form + connected list for a set of model-plan credentials, shared between the
// PERSONAL surface (/v1/me — your own plan) and the workspace POOL (/v1/workspace — the
// shared fallback). `scope` picks the wiring; the markup is identical, so it lives once. The
// caller supplies its own SettingsSection / heading around this.
export function ModelPlanManager({ scope }: { scope: Scope }) {
  const qc = useQueryClient()
  const query = scope === "pool" ? poolCredentialsQuery() : modelCredentialsQuery()
  // Both factories return ModelCredentialHint[]; they differ only in their literal queryKey,
  // which unions poorly across useQuery's overloads. The cast unifies the shape — the runtime
  // queryKey (and thus the cache entry) is still the scope's own.
  const {
    data: creds,
    isPending,
    isError,
    refetch,
  } = useQuery(query as ReturnType<typeof modelCredentialsQuery>)
  const reload = () => qc.invalidateQueries({ queryKey: query.queryKey })
  const connect = scope === "pool" ? api.connectPoolCredential : api.connectModelCredential
  const disconnect = scope === "pool" ? api.disconnectPoolCredential : api.disconnectModelCredential
  const prefix = scope === "pool" ? "pool-model-plan" : "model-plan"

  return (
    <>
      <div className="rounded-lg bg-secondary p-4">
        <ConnectForm connect={connect} prefix={prefix} onConnected={reload} />
      </div>

      {isPending ? (
        <SettingsListSkeleton />
      ) : isError ? (
        <LoadError
          title="Couldn’t load plans"
          testId={`${prefix}-retry`}
          onRetry={() => refetch()}
        />
      ) : // No plans yet renders NOTHING: the connect form above is the empty
      // state, and a "no plan yet" line under it would only repeat the form.
      !creds || creds.length === 0 ? null : (
        <SettingsGroup>
          {creds.map((c) => (
            <CredentialRow
              key={c.provider}
              cred={c}
              disconnect={disconnect}
              prefix={prefix}
              onDone={reload}
            />
          ))}
        </SettingsGroup>
      )}
    </>
  )
}

function ConnectForm({
  connect: connectFn,
  prefix,
  onConnected,
}: {
  connect: (input: { provider: Provider; kind: Kind; token: string }) => Promise<unknown>
  prefix: string
  onConnected: () => void
}) {
  const [provider, setProvider] = useState<Provider>("claude-code")
  const providerCfg = PROVIDERS.find((p) => p.id === provider) ?? PROVIDERS[0]
  const [kind, setKind] = useState<Kind>(providerCfg.kinds[0].id)
  const [token, setToken] = useState("")
  const kindCfg = providerCfg.kinds.find((k) => k.id === kind) ?? providerCfg.kinds[0]

  // Switching provider resets the kind to that provider's first (its plan) and clears input,
  // so you never submit a Codex login under the Claude provider.
  const pickProvider = (v: Provider) => {
    setProvider(v)
    setKind((PROVIDERS.find((p) => p.id === v) ?? PROVIDERS[0]).kinds[0].id)
    setToken("")
  }

  const connect = useApiMutation({
    mutationFn: () => connectFn({ provider, kind, token: token.trim() }),
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
        <Select value={provider} onValueChange={(v) => pickProvider(v as Provider)}>
          <SelectTrigger data-testid={`${prefix}-provider`} aria-label="Provider" className="w-40">
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
        <Select
          value={kind}
          onValueChange={(v) => {
            setKind(v as Kind)
            setToken("")
          }}
        >
          <SelectTrigger
            data-testid={`${prefix}-kind`}
            aria-label="Credential type"
            className="w-44"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {providerCfg.kinds.map((k) => (
              <SelectItem key={k.id} value={k.id}>
                {k.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {kindCfg.multiline ? (
        <Textarea
          data-testid={`${prefix}-token`}
          aria-label="Plan login (auth.json)"
          placeholder="Paste the contents of ~/.codex/auth.json"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          rows={4}
          className="font-mono text-2xs"
        />
      ) : (
        <Input
          data-testid={`${prefix}-token`}
          type="password"
          aria-label="Plan token or API key"
          placeholder="Paste your token"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && ready && connect.mutate()}
        />
      )}
      <p className="text-2xs text-muted-foreground">{kindCfg.how}</p>
      <div className="flex justify-end">
        <Button
          data-testid={`${prefix}-connect`}
          variant="secondary"
          size="sm"
          onClick={() => ready && connect.mutate()}
          loading={connect.isPending}
          disabled={connect.isPending || !ready}
        >
          Connect
        </Button>
      </div>
    </div>
  )
}

function CredentialRow({
  cred,
  disconnect: disconnectFn,
  prefix,
  onDone,
}: {
  cred: ModelCredentialHint
  disconnect: (provider: string) => Promise<void>
  prefix: string
  onDone: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const remove = useApiMutation({
    mutationFn: () => disconnectFn(cred.provider),
    success: "Plan disconnected",
    onSuccess: () => onDone(),
  })
  return (
    <ListRow
      data-testid={`${prefix}-row-${cred.provider}`}
      title={
        <span className="flex items-center gap-1.5">
          {providerLabel(cred.provider)}
          <Badge variant="outline">{kindLabel(cred.provider, cred.kind)}</Badge>
        </span>
      }
      meta={<span className="font-mono">connected · ••••{cred.hint}</span>}
      actions={
        <>
          <Button
            data-testid={`${prefix}-disconnect-${cred.provider}`}
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
            description="Runs that relied on it will stop until it is reconnected."
            confirmLabel="Disconnect"
            onConfirm={() => remove.mutate()}
          />
        </>
      }
    />
  )
}
