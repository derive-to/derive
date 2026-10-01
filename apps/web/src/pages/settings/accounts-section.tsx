import { useQuery } from "@tanstack/react-query"
import { type FormEvent, useState } from "react"
import { api, type ModelAccount, type NewModelAccount } from "@/api"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { LoadError } from "@/components/shared/load-error"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
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
import { SettingsSection } from "./settings-section"

const PROVIDER: Record<ModelAccount["provider"], string> = { claude: "Claude", codex: "Codex" }
const KIND: Record<ModelAccount["kind"], string> = {
  api_key: "API key",
  oauth: "OAuth token",
  login: "login",
  ortam_signin: "signed in on Derive",
}

/** "Your Claude", "Shared Codex": whose account and which provider. */
export const accountLabel = (a: ModelAccount): string =>
  `${a.shared ? "Shared" : a.mine ? "Your" : "A teammate's"} ${PROVIDER[a.provider]}`

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
  const [removing, setRemoving] = useState<ModelAccount | null>(null)
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
                return (
                  <div key={a.id} data-testid={`account-${a.id}`} className={rowClass()}>
                    <RowLine
                      icon={a.shared ? "workspace" : "user"}
                      title={accountLabel(a)}
                      detail={[
                        KIND[a.kind],
                        a.hint,
                        used.length ? `used by ${used.join(", ")}` : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    />
                    <Meta>
                      {a.status === "needs_signin" && (
                        <span className="text-warning">needs sign-in</span>
                      )}
                      {(a.mine || (a.shared && isOwner)) && (
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
                )
              })}
            </Group>
          )}
          <p className="text-sm text-muted-foreground">
            An agent uses the account picked on its Settings tab. Without one it uses its creator’s
            own account here, then a shared one. With none of those, its jobs fail.
          </p>
          {workspace.isError && (
            <LoadError
              layout="inline"
              title="Couldn’t load your role in this workspace."
              testId="accounts-workspace-retry"
              onRetry={() => void workspace.refetch()}
            />
          )}
          {!canAdd ? null : adding ? (
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
              Connect Claude or Codex
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
  const [provider, setProvider] = useState<NewModelAccount["provider"]>("claude")
  const [kind, setKind] = useState<NewModelAccount["kind"]>("api_key")
  const [secret, setSecret] = useState("")
  const [shared, setShared] = useState(false)
  const add = useApiMutation({
    mutationFn: () => api.addAccount({ provider, kind, secret: secret.trim(), shared }),
    invalidate: [["accounts"]],
    success: "Account connected",
    onSuccess: onDone,
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (secret.trim().length >= 8) add.mutate()
  }
  return (
    <form
      data-testid="account-form"
      onSubmit={submit}
      className="flex max-w-xl flex-col gap-3 rounded-xl border border-border p-4"
    >
      <div className="flex flex-wrap gap-2">
        <Select value={provider} onValueChange={(v) => setProvider(v as typeof provider)}>
          <SelectTrigger data-testid="account-provider" aria-label="Provider" className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="claude">Claude</SelectItem>
            <SelectItem value="codex">Codex</SelectItem>
          </SelectContent>
        </Select>
        <Select value={kind} onValueChange={(v) => setKind(v as typeof kind)}>
          <SelectTrigger data-testid="account-kind" aria-label="Kind" className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="api_key">API key</SelectItem>
            <SelectItem value="oauth">OAuth token</SelectItem>
            <SelectItem value="login">Login</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <Textarea
        value={secret}
        onChange={(e) => setSecret(e.target.value)}
        placeholder={kind === "login" ? "Paste the login file" : `Paste the ${KIND[kind]}`}
        aria-label="Secret"
        data-testid="account-secret"
        className="font-mono"
        autoComplete="off"
        spellCheck={false}
      />
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
          Connect
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
