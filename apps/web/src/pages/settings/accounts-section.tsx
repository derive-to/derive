import { useQuery } from "@tanstack/react-query"
import { type FormEvent, useState } from "react"
import { api, type ModelAccount, type NewModelAccount } from "@/api"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { LoadError } from "@/components/shared/load-error"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { accountsQuery, agentsQuery, workspaceQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import { Group, Meta, RowLine, rowClass } from "@/pages/agents/rows"
import { AgentRowsSkeleton } from "@/pages/agents/skeleton"
import { PlanConnection } from "./plan-connection"
import { SettingsSection } from "./settings-section"

const PROVIDER: Record<ModelAccount["provider"], string> = { claude: "Claude", codex: "Codex" }
const KIND: Record<ModelAccount["kind"], string> = {
  api_key: "API key",
  oauth: "OAuth token",
  login: "Plan",
}

/** "Your Claude", "Shared Codex": whose account and which provider. */
export const accountLabel = (a: ModelAccount): string =>
  a.name
    ? `${a.name}${a.shared ? " (shared)" : ""}`
    : `${a.shared ? "Shared" : a.mine ? "Your" : "A teammate's"} ${PROVIDER[a.provider]}`

// Settings › Model accounts: the model accounts agents call a model with. Yours, and the
// workspace's shared ones. A key is pasted once and never shown again; only its last four
// characters come back.
export function AccountsSection() {
  const accounts = useQuery(accountsQuery())
  const agents = useQuery(agentsQuery())
  const workspace = useQuery(workspaceQuery())
  const isOwner = workspace.data?.role === "owner"
  // Adding an account needs publish rights (Admin or Creator); viewers and commenters can't.
  const canAdd = workspace.data?.role === "owner" || workspace.data?.role === "editor"
  const [adding, setAdding] = useState(false)
  const [connecting, setConnecting] = useState<ModelAccount | null>(null)
  const [removing, setRemoving] = useState<ModelAccount | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)
  const rename = useApiMutation({
    mutationFn: (r: { id: string; name: string }) => api.renameAccount(r.id, r.name.trim() || null),
    invalidate: [["accounts"], ["agents"]],
    onSuccess: () => setRenaming(null),
  })
  const disconnect = useApiMutation({
    mutationFn: (a: ModelAccount) => api.deleteAccount(a.id),
    invalidate: [["accounts"], ["agents"]],
  })
  const usedBy = (a: ModelAccount) =>
    (agents.data ?? []).filter((g) => g.account_id === a.id).map((g) => g.name)

  return (
    <SettingsSection title="Model accounts">
      {accounts.isError ? (
        <LoadError
          title="Couldn’t load accounts."
          testId="accounts-retry"
          onRetry={() => void accounts.refetch()}
        />
      ) : accounts.isPending ? (
        <AgentRowsSkeleton rows={2} />
      ) : (
        <div className="flex flex-col gap-4">
          {accounts.data.length > 0 && (
            <Group testId="accounts">
              {accounts.data.map((a) => {
                const used = usedBy(a)
                const canEdit = a.mine || (a.shared && isOwner)
                if (renaming?.id === a.id)
                  return (
                    <form
                      key={a.id}
                      data-testid={`account-rename-form-${a.id}`}
                      className={rowClass()}
                      onSubmit={(e: FormEvent) => {
                        e.preventDefault()
                        rename.mutate(renaming)
                      }}
                    >
                      <Input
                        autoFocus
                        aria-label="Account name"
                        data-testid={`account-rename-input-${a.id}`}
                        placeholder={`${PROVIDER[a.provider]} (blank uses this)`}
                        value={renaming.name}
                        onChange={(e) => setRenaming({ id: a.id, name: e.target.value })}
                        className="max-w-xs"
                      />
                      <Meta>
                        <Button
                          type="submit"
                          size="xs"
                          data-testid={`account-rename-save-${a.id}`}
                          loading={rename.isPending}
                        >
                          Save
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          data-testid={`account-rename-cancel-${a.id}`}
                          onClick={() => setRenaming(null)}
                          className="text-muted-foreground"
                        >
                          Cancel
                        </Button>
                      </Meta>
                    </form>
                  )
                return (
                  <div
                    key={a.id}
                    data-testid={`account-${a.id}`}
                    className={`${rowClass()} max-sm:flex-wrap`}
                  >
                    <RowLine
                      icon={a.shared ? "workspace" : "user"}
                      title={accountLabel(a)}
                      detail={[
                        a.name ? PROVIDER[a.provider] : null,
                        KIND[a.kind],
                        a.status === "connecting"
                          ? "Connection in progress"
                          : a.status === "needs_attention"
                            ? "Reconnect to continue"
                            : a.status === "not_checked"
                              ? "Access not checked yet"
                              : a.hint,
                        used.length ? `used by ${used.join(", ")}` : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    />
                    <div className="contents max-sm:block max-sm:w-full max-sm:pl-7">
                      <Meta>
                        {canEdit && a.provider === "codex" && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            data-testid={`account-reconnect-${a.id}`}
                            onClick={() => {
                              setAdding(false)
                              setConnecting(a)
                            }}
                          >
                            {a.status === "connecting" ? "Continue" : "Reconnect"}
                          </Button>
                        )}
                        {canEdit && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            data-testid={`account-rename-${a.id}`}
                            onClick={() => setRenaming({ id: a.id, name: a.name ?? "" })}
                            className="text-muted-foreground"
                          >
                            Rename
                          </Button>
                        )}
                        {canEdit && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            data-testid={`account-disconnect-${a.id}`}
                            onClick={() => setRemoving(a)}
                            className="text-muted-foreground"
                          >
                            Disconnect
                          </Button>
                        )}
                      </Meta>
                    </div>
                  </div>
                )
              })}
            </Group>
          )}
          <p className="text-sm text-muted-foreground">
            Connect your plan or an API key. Choose an account in each agent’s settings.
          </p>
          {workspace.isError && (
            <LoadError
              layout="inline"
              title="Couldn’t load your role in this workspace."
              testId="accounts-workspace-retry"
              onRetry={() => void workspace.refetch()}
            />
          )}
          {connecting ? (
            <PlanConnection
              accountId={connecting.id}
              kind={connecting.kind === "api_key" ? "api_key" : "login"}
              resumeId={
                connecting.status === "connecting" || connecting.status === "needs_attention"
                  ? connecting.id
                  : undefined
              }
              onDone={() => setConnecting(null)}
            />
          ) : !canAdd ? null : adding ? (
            <AddAccount canShare={isOwner} onDone={() => setAdding(false)} />
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="account-connect"
              onClick={() => setAdding(true)}
              className="self-start"
            >
              Connect a plan or API key
            </Button>
          )}
        </div>
      )}
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={removing ? `Disconnect ${accountLabel(removing)}?` : ""}
        description="Agents assigned to it fall back to their creator’s own account, then a shared one."
        confirmLabel="Disconnect"
        confirmTestId="account-disconnect-confirm"
        onConfirm={() =>
          removing ? disconnect.mutateAsync(removing).then(() => setRemoving(null)) : undefined
        }
      />
    </SettingsSection>
  )
}

function AddAccount({ canShare, onDone }: { canShare: boolean; onDone: () => void }) {
  const [advanced, setAdvanced] = useState(false)
  const [checking, setChecking] = useState<string | null>(null)
  const options = useQuery({
    queryKey: ["account-login-options"],
    queryFn: api.accountLoginOptions,
  })
  const [provider, setProvider] = useState<NewModelAccount["provider"]>("codex")
  const [kind, setKind] = useState<NewModelAccount["kind"]>("login")
  const [fileError, setFileError] = useState("")
  const [secret, setSecret] = useState("")
  const [name, setName] = useState("")
  const [shared, setShared] = useState(false)
  const add = useApiMutation({
    mutationFn: async () =>
      provider === "codex" && options.data?.device_login
        ? api.connectPlan({
            kind: kind === "api_key" ? "api_key" : "login",
            secret: secret.trim(),
            name: name.trim(),
            shared,
          })
        : api.addAccount({ provider, kind, secret: secret.trim(), name: name.trim(), shared }),
    invalidate: [["accounts"]],
    onSuccess: (result) => ("phase" in result ? setChecking(result.id) : onDone()),
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (secret.trim().length >= 8) add.mutate()
  }
  if (checking)
    return (
      <PlanConnection
        resumeId={checking}
        kind={kind === "api_key" ? "api_key" : "login"}
        onDone={onDone}
      />
    )
  if (!advanced)
    return (
      <div className="flex flex-col gap-2">
        <PlanConnection onDone={onDone} />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid="account-other-method"
          onClick={() => setAdvanced(true)}
          className="self-start text-muted-foreground"
        >
          Use an API key or import a login
        </Button>
      </div>
    )
  return (
    <form
      data-testid="account-form"
      onSubmit={submit}
      className="flex max-w-xl flex-col gap-3 rounded-xl border border-border p-4"
    >
      <div className="flex flex-wrap gap-2">
        <Select
          value={provider}
          onValueChange={(v) => {
            setProvider(v as typeof provider)
            setKind(v === "codex" ? "login" : "api_key")
            setSecret("")
            setFileError("")
          }}
        >
          <SelectTrigger data-testid="account-provider" aria-label="Provider" className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="claude">Claude</SelectItem>
            <SelectItem value="codex">Codex</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={kind}
          onValueChange={(v) => {
            setKind(v as typeof kind)
            setSecret("")
            setFileError("")
          }}
        >
          <SelectTrigger data-testid="account-kind" aria-label="Kind" className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="api_key">API key</SelectItem>
            {provider === "claude" && <SelectItem value="oauth">OAuth token</SelectItem>}
            {provider === "codex" && <SelectItem value="login">My Codex plan</SelectItem>}
          </SelectContent>
        </Select>
      </div>
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Name it (optional), e.g. Work Max plan"
        aria-label="Name"
        data-testid="account-name"
        maxLength={80}
      />
      {kind === "login" ? (
        <label className="flex flex-col gap-3 text-sm">
          <span>
            Sign in with <code>codex login</code>, then choose <code>~/.codex/auth.json</code>.
          </span>
          <Input
            type="file"
            accept=".json,application/json"
            aria-label="Codex login file"
            data-testid="account-login-file"
            onChange={async (e) => {
              setSecret("")
              setFileError("")
              const file = e.target.files?.[0]
              if (!file) return
              if (file.size > 20_000) return setFileError("Choose your Codex auth.json file.")
              try {
                setSecret(await file.text())
              } catch {
                setFileError("Couldn’t read that file. Choose it again.")
              }
            }}
          />
          <span className="text-muted-foreground">
            Saved encrypted. Only tasks that use this account can read it.
          </span>
          {fileError && (
            <span role="alert" className="text-destructive">
              {fileError}
            </span>
          )}
        </label>
      ) : (
        <Textarea
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          placeholder={`Paste the ${KIND[kind]}`}
          aria-label="Secret"
          data-testid="account-secret"
          className="font-mono"
          autoComplete="off"
          spellCheck={false}
        />
      )}
      {canShare && (
        <Label className="flex items-center gap-2 text-sm font-normal">
          <Checkbox
            checked={shared}
            onCheckedChange={(v) => setShared(v === true)}
            data-testid="account-shared"
          />
          Share with the workspace
        </Label>
      )}
      <div className="flex items-center gap-2">
        <Button
          type="submit"
          size="sm"
          data-testid="account-save"
          disabled={secret.trim().length < 8}
          loading={add.isPending}
        >
          {provider === "codex" && options.data?.device_login
            ? "Check and connect"
            : "Save account"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid="account-cancel"
          onClick={onDone}
        >
          Cancel
        </Button>
      </div>
    </form>
  )
}
