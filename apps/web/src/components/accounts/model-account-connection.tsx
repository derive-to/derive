import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useRef, useState } from "react"
import { api, type CloudModelConnection, type RuntimeModelSignIn } from "@/api"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { LoadError } from "@/components/shared/load-error"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { runtimeModelConnectionsQuery, workflowRuntimesQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"

export function ModelAccountConnection({
  account,
  canConnect,
}: {
  account: CloudModelConnection
  canConnect: boolean
}) {
  const client = useQueryClient()
  const queryKey = ["runtime-model-status", account.id]
  const [code, setCode] = useState("")
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const [disconnected, setDisconnected] = useState(false)
  // Memory-only and shared across Settings / workflow setup. Returning from a
  // provider tab or changing screens must not create another account or lose the attempt.
  const pollKey = ["runtime-model-sign-in", account.id]
  const poll = useQuery<RuntimeModelSignIn | null>({
    queryKey: pollKey,
    queryFn: () => {
      const attempt = client.getQueryData<RuntimeModelSignIn | null>(pollKey)
      return attempt ? api.runtimeModelSignIn(account.id, attempt.id) : Promise.resolve(null)
    },
    enabled: (query) => query.state.data?.state === "pending" && !account.revoked_at,
    refetchInterval: (query) => (query.state.data?.state === "pending" ? 3000 : false),
    gcTime: 30 * 60 * 1000,
    meta: { persist: false },
  })
  const current = poll.data
  const status = useQuery({
    queryKey,
    queryFn: () => api.runtimeModelStatus(account.id),
    refetchInterval: current?.state === "pending" ? 3000 : 15000,
    meta: { persist: false },
  })
  const start = useApiMutation({
    mutationFn: () => api.startRuntimeModelSignIn(account.id),
    onSuccess: async (value) => {
      await client.cancelQueries({ queryKey: pollKey })
      client.setQueryData(pollKey, value)
      setCode("")
    },
  })
  const complete = useApiMutation({
    mutationFn: () => api.completeRuntimeModelSignIn(account.id, current?.id ?? "", code.trim()),
    onSuccess: async (value) => {
      await client.cancelQueries({ queryKey: pollKey })
      client.setQueryData(pollKey, value)
      setCode("")
    },
    invalidate: [queryKey],
  })
  const cancel = useApiMutation({
    mutationFn: () => api.cancelRuntimeModelSignIn(account.id, current?.id ?? ""),
    onSuccess: async (value) => {
      await client.cancelQueries({ queryKey: pollKey })
      client.setQueryData(pollKey, value)
      setCode("")
    },
  })
  const disconnect = useApiMutation({
    mutationFn: () => api.disconnectRuntimeModel(account.id),
    invalidate: [
      runtimeModelConnectionsQuery().queryKey,
      queryKey,
      ["runtime-model-binding"],
      ["contexts"],
      workflowRuntimesQuery().queryKey,
    ],
    success: "Account disconnected for all workflows",
    onSuccess: async () => {
      await client.cancelQueries({ queryKey: pollKey })
      client.setQueryData(pollKey, null)
      setCode("")
      setDisconnected(true)
    },
  })
  const usage = useQuery({
    queryKey: ["runtime-model-usage", account.id],
    queryFn: () => api.runtimeModelUsage(account.id),
    staleTime: 0,
    meta: { persist: false },
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
        {status.isPending
          ? "Checking account…"
          : status.isError
            ? "Connection status unavailable"
            : revoked
              ? "Disconnected from workflows."
              : status.data?.account?.status === "active"
                ? "Connected"
                : "Sign-in needed"}
        {status.data?.account?.identity?.email ? ` · ${status.data.account.identity.email}` : ""}
      </p>
      <div className="flex flex-wrap gap-2">
        {!revoked && canConnect && !account.unavailable_reason && (
          <Button
            type="button"
            data-testid="context-managed-model-connect"
            loading={start.isPending}
            disabled={current?.state === "pending" || complete.isPending || cancel.isPending}
            onClick={() => start.mutate()}
          >
            {status.data?.account ? "Reconnect account" : "Connect account"}
          </Button>
        )}
        {!disconnected && (
          <Button
            type="button"
            data-testid="context-managed-model-disconnect"
            variant="outline"
            onClick={() => {
              usage.refetch()
              setConfirmDisconnect(true)
            }}
          >
            {revoked ? "Finish disconnect" : "Disconnect from all workflows…"}
          </Button>
        )}
      </div>
      <AccountUsage usage={usage.data} failed={usage.isError} onRetry={() => usage.refetch()} />
      <ConfirmDialog
        open={confirmDisconnect}
        onOpenChange={setConfirmDisconnect}
        title="Disconnect this account from all workflows?"
        description={
          <span>
            Every workflow using this account will lose access and active work will stop.
            Reconnecting later requires a new account selection. To change just one workflow,
            replace its account in Configuration instead.
            {usage.data && (
              <span className="block">
                {usage.data.workflows.length + usage.data.other_workflow_count} affected
                workflow(s): {usage.data.workflows.map((workflow) => workflow.name).join(", ")}
                {usage.data.other_workflow_count
                  ? " (plus workflows you no longer have access to)"
                  : ""}
                .
              </span>
            )}
            {usage.isError && (
              <span className="block">The affected workflow list is unavailable.</span>
            )}
          </span>
        }
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
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return
                    event.preventDefault()
                    if (code.trim() && !complete.isPending) complete.mutate()
                  }}
                />
              </label>
              <Button
                type="button"
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
            type="button"
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
            ? "Sign-in completed. Connection health is shown above."
            : current.state === "expired"
              ? "Sign-in expired. Start again; your setup is unchanged."
              : current.state === "cancelled"
                ? "Sign-in cancelled. Your setup is unchanged."
                : "Sign-in failed. Start again; your setup is unchanged."}
        </p>
      )}
    </div>
  )
}

function AccountUsage({
  usage,
  failed,
  onRetry,
}: {
  usage: Awaited<ReturnType<typeof api.runtimeModelUsage>> | undefined
  failed: boolean
  onRetry: () => void
}) {
  if (failed)
    return (
      <LoadError
        title="Could not load affected workflows"
        testId="model-account-usage-retry"
        onRetry={onRetry}
      />
    )
  if (!usage)
    return <span className="block text-sm text-muted-foreground">Loading affected workflows…</span>
  return (
    <span className="block text-sm text-muted-foreground">
      {usage.workflows.length + usage.other_workflow_count === 0
        ? "No workflows use this account yet."
        : "Used by:"}
      {usage.workflows.map((workflow) => (
        <Link
          key={workflow.id}
          to="/workflows"
          search={{ workflow: workflow.id }}
          className="block underline"
          data-testid={`model-account-workflow-${workflow.id}`}
        >
          {workflow.name}
        </Link>
      ))}
      {usage.other_workflow_count > 0 && (
        <span className="block">
          {usage.other_workflow_count} other workflow(s) you no longer have access to.
        </span>
      )}
    </span>
  )
}

/** Shared account creation; assigning it to a workflow remains the caller's decision. */
export function NewModelAccount({
  disabled = false,
  onCreated,
}: {
  disabled?: boolean
  onCreated: (account: CloudModelConnection) => void
}) {
  const request = useRef<{ name: string; provider: string; id: string } | null>(null)
  const [name, setName] = useState("")
  const [provider, setProvider] = useState<"codex" | "claude-code">("codex")
  const create = useApiMutation({
    // Capture the receiver at the click so a polling update cannot advance its binding revision.
    mutationFn: (_accept: typeof onCreated) => {
      const trimmed = name.trim()
      if (
        !request.current ||
        request.current.name !== trimmed ||
        request.current.provider !== provider
      )
        request.current = { name: trimmed, provider, id: crypto.randomUUID() }
      return api.createRuntimeModelConnection(trimmed, provider, request.current.id)
    },
    invalidate: [runtimeModelConnectionsQuery().queryKey],
    onSuccess: (account, accept) => {
      setName("")
      request.current = null
      accept(account)
    },
  })
  const connect = () => {
    if (!disabled && name.trim() && !create.isPending) create.mutate(onCreated)
  }
  return (
    <details>
      <summary data-testid="context-model-account-add" className="cursor-pointer text-sm underline">
        Connect an account
      </summary>
      <div className="mt-3 flex flex-col gap-3">
        <label className="flex flex-col gap-1.5 text-sm">
          Account name
          <Input
            data-testid="context-model-account-name"
            value={name}
            maxLength={100}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return
              event.preventDefault()
              connect()
            }}
            disabled={disabled || create.isPending}
            placeholder="Work account"
          />
        </label>
        <label className="flex flex-col gap-1.5 text-sm">
          Provider
          <select
            data-testid="context-managed-model-provider"
            value={provider}
            className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm"
            disabled={disabled || create.isPending}
            onChange={(e) => setProvider(e.target.value as typeof provider)}
          >
            <option value="codex">Codex</option>
            <option value="claude-code">Claude Code</option>
          </select>
        </label>
        <Button
          type="button"
          data-testid="context-model-account-create"
          className="self-start"
          disabled={disabled || !name.trim() || create.isPending}
          loading={create.isPending}
          onClick={connect}
        >
          Connect account
        </Button>
      </div>
    </details>
  )
}
