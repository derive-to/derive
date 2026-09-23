import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { api, type CloudModelConnection, type RuntimeModelSignIn } from "@/api"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { LoadError } from "@/components/shared/load-error"
import { SectionTitle } from "@/components/shared/section-title"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { contextRuntimeQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"

const accountsKey = ["runtime-model-connections"]
const bindingKey = (id: string) => ["runtime-model-binding", id]

export function RuntimeModelAccount({
  contextId,
  canEdit,
}: {
  contextId: string
  canEdit: boolean
}) {
  const binding = useQuery({
    queryKey: bindingKey(contextId),
    queryFn: () => api.runtimeModelBinding(contextId),
    refetchInterval: 15000,
  })
  const accounts = useQuery({
    queryKey: accountsKey,
    queryFn: api.runtimeModelConnections,
    enabled: canEdit,
  })
  const [draft, setDraft] = useState<{ id: string; revision: number | null } | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [name, setName] = useState("")
  const [provider, setProvider] = useState<"codex" | "claude-code">("codex")
  const selected = binding.data?.connection
  const chosenId = draft?.id ?? selected?.id ?? ""
  const chosen = accounts.data?.items.find((item) => item.id === chosenId)
  const save = useApiMutation({
    mutationFn: (remove: boolean) =>
      api.setRuntimeModelBinding(
        contextId,
        remove ? null : chosenId,
        remove
          ? (binding.data?.revision ?? null)
          : draft
            ? draft.revision
            : (binding.data?.revision ?? null),
      ),
    invalidate: [bindingKey(contextId), contextRuntimeQuery(contextId).queryKey],
    success: (_, remove) =>
      remove ? "This job’s account access was removed" : "Model account selected",
    onSuccess: () => setDraft(null),
  })
  const create = useApiMutation({
    mutationFn: (_revision: number | null) =>
      api.createRuntimeModelConnection(name.trim(), provider),
    invalidate: [accountsKey],
    onSuccess: (account, revision) => {
      setDraft({ id: account.id, revision })
      setName("")
    },
  })
  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-card p-5">
      <SectionTitle>Model account</SectionTitle>
      {binding.isError && (
        <LoadError
          title="Could not load the job’s account"
          testId="context-model-binding-error"
          onRetry={() => binding.refetch()}
        />
      )}
      {!binding.isError && (
        <p className="text-sm">
          {binding.isPending
            ? "Loading model account…"
            : selected
              ? `${selected.name} · ${selected.provider === "codex" ? "Codex" : "Claude Code"}${selected.revoked ? " · Disconnected" : ""}`
              : "No account selected for this job."}
        </p>
      )}
      {canEdit && (
        <>
          <p className="text-sm text-muted-foreground">
            Choose one of your accounts to let authorized teammates run this job. Other jobs can use
            the same account while keeping separate files and tools. Changes take effect before the
            next run; active work using the previous selection stops.
          </p>
          {accounts.isError && (
            <LoadError
              title="Could not load your model accounts"
              testId="context-model-accounts-error"
              onRetry={() => accounts.refetch()}
            />
          )}
          <label className="flex flex-col gap-1.5 text-sm">
            Your accounts
            <select
              data-testid="context-model-account-select"
              className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm"
              value={chosenId}
              disabled={!binding.data || save.isPending}
              onChange={(e) =>
                setDraft({ id: e.target.value, revision: binding.data?.revision ?? null })
              }
            >
              <option value="">Choose an account</option>
              {selected && !accounts.data?.items.some((item) => item.id === selected.id) && (
                <option value={selected.id}>{selected.name} · Already shared with this job</option>
              )}
              {accounts.data?.items.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} · {item.provider === "codex" ? "Codex" : "Claude Code"}
                  {item.revoked_at ? " · Disconnected" : ""}
                </option>
              ))}
            </select>
          </label>
          <div className="flex flex-wrap gap-2">
            <Button
              data-testid="context-model-account-use"
              disabled={!chosen || !!chosen.revoked_at || !draft || save.isPending}
              loading={save.isPending}
              onClick={() => save.mutate(false)}
            >
              Use this account
            </Button>
            {selected && (
              <Button
                data-testid="context-model-account-remove"
                variant="outline"
                disabled={save.isPending}
                onClick={() => setConfirmRemove(true)}
              >
                Remove this job’s access
              </Button>
            )}
          </div>
          <ConfirmDialog
            open={confirmRemove}
            onOpenChange={setConfirmRemove}
            title="Remove this job’s account access?"
            description="Active work will stop and this job cannot run until an account is selected. Other jobs keep their access."
            confirmLabel="Remove access"
            onConfirm={() => save.mutateAsync(true).then(() => undefined)}
          />
          <details>
            <summary
              data-testid="context-model-account-add"
              className="cursor-pointer text-sm underline"
            >
              Add a model account
            </summary>
            <div className="mt-3 flex flex-col gap-3">
              <label className="flex flex-col gap-1.5 text-sm">
                Account name
                <Input
                  data-testid="context-model-account-name"
                  value={name}
                  maxLength={100}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Work account"
                />
              </label>
              <label className="flex flex-col gap-1.5 text-sm">
                Agent
                <select
                  data-testid="context-managed-model-provider"
                  className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm"
                  value={provider}
                  onChange={(e) => setProvider(e.target.value as typeof provider)}
                >
                  <option value="codex">Codex</option>
                  <option value="claude-code">Claude Code</option>
                </select>
              </label>
              <Button
                data-testid="context-model-account-create"
                className="self-start"
                disabled={!name.trim() || !binding.data}
                loading={create.isPending}
                onClick={() => create.mutate(binding.data?.revision ?? null)}
              >
                Add account
              </Button>
            </div>
          </details>
          {chosen && <ConnectionControls key={chosen.id} account={chosen} contextId={contextId} />}
        </>
      )}
    </div>
  )
}

function ConnectionControls({
  account,
  contextId,
}: {
  account: CloudModelConnection
  contextId: string
}) {
  const client = useQueryClient()
  const queryKey = ["runtime-model-status", account.id]
  const [attempt, setAttempt] = useState<RuntimeModelSignIn | null>(null)
  const [code, setCode] = useState("")
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const [disconnected, setDisconnected] = useState(false)
  const pollKey = ["runtime-model-sign-in", account.id, attempt?.id]
  const poll = useQuery({
    queryKey: pollKey,
    queryFn: () => api.runtimeModelSignIn(account.id, attempt?.id ?? ""),
    enabled: attempt?.state === "pending" && !account.revoked_at,
    refetchInterval: (query) =>
      query.state.data?.state === "pending" || !query.state.data ? 3000 : false,
  })
  const current = poll.data ?? attempt
  const status = useQuery({
    queryKey,
    queryFn: () => api.runtimeModelStatus(account.id),
    refetchInterval: current?.state === "pending" ? 3000 : 15000,
  })
  const start = useApiMutation({
    mutationFn: () => api.startRuntimeModelSignIn(account.id),
    onSuccess: (value) => {
      setAttempt(value)
      setCode("")
    },
  })
  const complete = useApiMutation({
    mutationFn: () => api.completeRuntimeModelSignIn(account.id, current?.id ?? "", code.trim()),
    onSuccess: (value) => {
      setAttempt(value)
      setCode("")
      client.setQueryData(pollKey, value)
    },
    invalidate: [queryKey],
  })
  const cancel = useApiMutation({
    mutationFn: () => api.cancelRuntimeModelSignIn(account.id, current?.id ?? ""),
    onSuccess: (value) => {
      setAttempt(value)
      client.setQueryData(pollKey, value)
      setCode("")
    },
  })
  const disconnect = useApiMutation({
    mutationFn: () => api.disconnectRuntimeModel(account.id),
    invalidate: [
      accountsKey,
      queryKey,
      bindingKey(contextId),
      contextRuntimeQuery(contextId).queryKey,
    ],
    success: "Account disconnected for all jobs",
    onSuccess: () => {
      setAttempt(null)
      setCode("")
      setDisconnected(true)
    },
  })
  const revoked = !!account.revoked_at || status.data?.revoked
  return (
    <div className="flex flex-col gap-3 border-t pt-3">
      {status.isError && (
        <LoadError
          title="Could not check model account"
          testId="context-managed-model-error"
          onRetry={() => status.refetch()}
        />
      )}
      <p className="text-sm">
        {revoked
          ? "Disconnected from jobs."
          : status.data?.account?.status === "active"
            ? "Connected"
            : "Sign-in needed"}
        {status.data?.account?.identity?.email ? ` · ${status.data.account.identity.email}` : ""}
      </p>
      <div className="flex flex-wrap gap-2">
        {!revoked && (
          <Button
            data-testid="context-managed-model-connect"
            loading={start.isPending}
            disabled={current?.state === "pending"}
            onClick={() => start.mutate()}
          >
            {status.data?.account ? "Reconnect account" : "Connect account"}
          </Button>
        )}
        {!disconnected && (
          <Button
            data-testid="context-managed-model-disconnect"
            variant="outline"
            onClick={() => setConfirmDisconnect(true)}
          >
            {revoked ? "Finish disconnect" : "Disconnect from all jobs…"}
          </Button>
        )}
      </div>
      <ConfirmDialog
        open={confirmDisconnect}
        onOpenChange={setConfirmDisconnect}
        title="Disconnect this account from all jobs?"
        description="Every job using this account will lose access. To change only this job, use Remove this job’s access instead."
        confirmLabel="Disconnect account"
        onConfirm={() => disconnect.mutateAsync().then(() => undefined)}
      />
      {!revoked && current?.state === "pending" && (
        <div className="flex flex-col gap-3">
          {current.user_code && (
            <p className="text-sm">
              Enter this code when signing in:{" "}
              <strong className="font-mono">{current.user_code}</strong>
            </p>
          )}
          {(current.verification_url || current.authorize_url) && (
            <a
              data-testid="context-managed-model-authorize"
              className="text-sm underline"
              href={current.verification_url ?? current.authorize_url ?? undefined}
              target="_blank"
              rel="noopener noreferrer"
            >
              Sign in with {account.provider === "codex" ? "OpenAI" : "Anthropic"}
            </a>
          )}
          {current.authorize_url && (
            <>
              <label className="flex flex-col gap-1.5 text-sm">
                Authorization code
                <Input
                  data-testid="context-managed-model-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  autoComplete="off"
                />
              </label>
              <Button
                data-testid="context-managed-model-complete"
                className="self-start"
                loading={complete.isPending}
                disabled={!code.trim()}
                onClick={() => complete.mutate()}
              >
                Finish connecting
              </Button>
            </>
          )}
          {poll.isError && (
            <LoadError
              title="Could not check sign-in"
              testId="context-managed-sign-in-error"
              onRetry={() => poll.refetch()}
            />
          )}
          <Button
            data-testid="context-managed-model-cancel"
            variant="outline"
            className="self-start"
            loading={cancel.isPending}
            onClick={() => cancel.mutate()}
          >
            Cancel sign-in
          </Button>
        </div>
      )}
      {!revoked && current && current.state !== "pending" && (
        <p className="text-sm">
          {current.state === "complete"
            ? "Account connected."
            : "Sign-in ended. You can start again."}
        </p>
      )}
    </div>
  )
}
