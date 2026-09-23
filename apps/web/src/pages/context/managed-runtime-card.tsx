import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { api, type RuntimeModelSignIn } from "@/api"
import { LoadError } from "@/components/shared/load-error"
import { SectionTitle } from "@/components/shared/section-title"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { contextRuntimeQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import { RuntimeScheduleCard } from "./runtime-schedule-card"

type RuntimeState = Awaited<ReturnType<typeof api.getContextRuntime>>

export function ManagedRuntimeCard({
  contextId,
  state,
}: {
  contextId: string
  state: RuntimeState
}) {
  const queryKey = contextRuntimeQuery(contextId).queryKey
  const setup = useApiMutation({
    mutationFn: () => api.setupContextRuntime(contextId),
    invalidate: [queryKey],
    success: "Preparing your workspace",
  })
  const cancel = useApiMutation({
    mutationFn: () => api.cancelContextRuntimeSetup(contextId),
    invalidate: [queryKey],
    success: "Setup cancelled",
  })
  const run = useApiMutation({
    mutationFn: () => api.runSavedRuntimeJob(contextId),
    invalidate: [queryKey],
    success: "Job queued",
  })
  const disable = useApiMutation({
    mutationFn: () => api.disableContextRuntime(contextId),
    invalidate: [queryKey],
    success: "Cloud runs disabled",
  })
  const ready = state.runtime && !state.runtime.disabled_at
  const job = state.schedule
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <SectionTitle>Cloud job</SectionTitle>
        <p className="text-sm text-muted-foreground">
          Your agent keeps its files between runs. Anyone with permission to run this job uses its
          saved agent and tools.
        </p>
      </div>
      {state.can_edit && <RuntimeModelAccount contextId={contextId} />}
      {!state.runtime && (
        <div className="flex flex-col gap-3 rounded-xl border bg-card p-5">
          {!state.setup ? (
            <>
              <p className="text-sm text-muted-foreground">
                Connect a model account, then prepare the workspace for this job.
              </p>
              {state.can_edit && (
                <Button
                  data-testid="context-managed-setup"
                  className="self-start"
                  loading={setup.isPending}
                  onClick={() => setup.mutate()}
                >
                  Prepare workspace
                </Button>
              )}
            </>
          ) : (
            <>
              <p className="text-sm">
                {state.setup.phase === "failed"
                  ? "Setup ended. Create a new Context to try again."
                  : state.setup.cancelled_at
                    ? "Removing the unfinished workspace…"
                    : "Preparing your workspace… You can leave this page while setup continues."}
              </p>
              {state.can_edit &&
                !state.setup.cancelled_at &&
                !["failed", "binding", "ready", "deleting"].includes(state.setup.phase) && (
                  <Button
                    data-testid="context-managed-cancel"
                    variant="outline"
                    className="self-start"
                    loading={cancel.isPending}
                    onClick={() => cancel.mutate()}
                  >
                    Cancel setup
                  </Button>
                )}
            </>
          )}
        </div>
      )}
      {state.runtime?.disabled_at && (
        <p className="text-sm text-muted-foreground">
          Cloud runs are disabled. Previous reports remain available.
        </p>
      )}
      {ready && (
        <>
          {state.can_edit && (
            <RuntimeScheduleCard
              contextId={contextId}
              schedule={job}
              nextRunAt={state.next_run_at}
            />
          )}
          {job && (
            <div className="flex flex-col gap-3 rounded-xl border bg-card p-5">
              <SectionTitle>{job.provider === "codex" ? "Codex" : "Claude Code"}</SectionTitle>
              <p className="whitespace-pre-wrap text-sm">{job.instruction}</p>
              <p className="text-sm text-muted-foreground">
                {state.next_run_at
                  ? `Next run: ${new Date(state.next_run_at).toLocaleString()}`
                  : "Schedule paused"}
              </p>
              <Button
                data-testid="context-managed-run"
                className="self-start"
                disabled={job.enabled !== 1}
                loading={run.isPending}
                onClick={() => run.mutate()}
              >
                Run now
              </Button>
            </div>
          )}
          {state.can_edit && (
            <Button
              data-testid="context-managed-disable"
              variant="outline"
              className="self-start"
              loading={disable.isPending}
              onClick={() => disable.mutate()}
            >
              Disable cloud runs
            </Button>
          )}
        </>
      )}
      <div className="flex flex-col gap-3">
        <SectionTitle>Recent runs</SectionTitle>
        {state.runs.length === 0 && <p className="text-sm text-muted-foreground">No runs yet.</p>}
        {state.runs.map((item) => (
          <div key={item.id} className="flex flex-col gap-2 rounded-lg border bg-card p-4 text-sm">
            <span>
              {new Date(item.created_at).toLocaleString()} · {item.status}
            </span>
            {item.attempt?.result_json && (
              <p className="whitespace-pre-wrap">{JSON.parse(item.attempt.result_json).summary}</p>
            )}
            {item.attempt?.save_status === "saved" && (
              <span className="text-muted-foreground">Files saved for the next run</span>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function RuntimeModelAccount({ contextId }: { contextId: string }) {
  const client = useQueryClient()
  const queryKey = ["context-runtime-model", contextId]
  const [provider, setProvider] = useState<"codex" | "claude-code">("codex")
  const [attempt, setAttempt] = useState<RuntimeModelSignIn | null>(null)
  const [code, setCode] = useState("")
  const poll = useQuery({
    queryKey: ["context-runtime-sign-in", contextId, attempt?.id],
    queryFn: () => api.runtimeModelSignIn(contextId, attempt?.id ?? ""),
    enabled: attempt?.state === "pending",
    refetchInterval: (query) =>
      query.state.data?.state === "pending" || !query.state.data ? 3000 : false,
  })
  const current = poll.data ?? attempt
  const models = useQuery({
    queryKey,
    queryFn: () => api.runtimeModels(contextId),
    refetchInterval: current?.state === "pending" ? 5000 : 15000,
  })
  const start = useApiMutation({
    mutationFn: () => api.startRuntimeModelSignIn(contextId, provider),
    onSuccess: (value) => {
      setAttempt(value)
      setCode("")
    },
  })
  const complete = useApiMutation({
    mutationFn: () => api.completeRuntimeModelSignIn(contextId, current?.id ?? "", code.trim()),
    onSuccess: (value) => {
      setAttempt(value)
      setCode("")
      client.setQueryData(["context-runtime-sign-in", contextId, value.id], value)
    },
    invalidate: [queryKey],
  })
  const cancel = useApiMutation({
    mutationFn: () => api.cancelRuntimeModelSignIn(contextId, current?.id ?? ""),
    onSuccess: () => setAttempt(null),
  })
  const disconnect = useApiMutation({
    mutationFn: () => api.disconnectRuntimeModel(contextId, provider),
    invalidate: [queryKey],
    success: "Model account disconnected",
  })
  const connection = models.data?.items.find(
    (item) => item.harness === (provider === "codex" ? "codex" : "claude_code"),
  )
  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-card p-5">
      <SectionTitle>Agent model account</SectionTitle>
      <p className="text-sm text-muted-foreground">
        Connecting an account lets this job use it when an authorized workspace member starts a run
        or its schedule fires.
      </p>
      <label className="flex flex-col gap-1.5 text-sm">
        Agent
        <select
          data-testid="context-managed-model-provider"
          className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm"
          value={provider}
          disabled={current?.state === "pending" || start.isPending}
          onChange={(event) => setProvider(event.target.value as "codex" | "claude-code")}
        >
          <option value="codex">Codex</option>
          <option value="claude-code">Claude Code</option>
        </select>
      </label>
      {models.isError && (
        <LoadError
          title="Could not load model accounts"
          testId="context-managed-model-error"
          onRetry={() => models.refetch()}
        />
      )}
      {connection && (
        <p className="text-sm">
          {connection.status === "active" ? "Connected" : "Sign-in needed"}
          {connection.identity?.email ? ` · ${connection.identity.email}` : ""}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          data-testid="context-managed-model-connect"
          loading={start.isPending}
          disabled={current?.state === "pending"}
          onClick={() => start.mutate()}
        >
          {connection ? "Reconnect account" : "Connect account"}
        </Button>
        {connection && (
          <Button
            data-testid="context-managed-model-disconnect"
            variant="outline"
            loading={disconnect.isPending}
            onClick={() => disconnect.mutate()}
          >
            Disconnect account
          </Button>
        )}
      </div>
      {current?.state === "pending" && (
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
              Sign in with {provider === "codex" ? "OpenAI" : "Anthropic"}
            </a>
          )}
          {current.authorize_url && (
            <>
              <label className="flex flex-col gap-1.5 text-sm">
                Authorization code
                <Input
                  data-testid="context-managed-model-code"
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
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
      {current && current.state !== "pending" && (
        <p className="text-sm">
          {current.state === "complete"
            ? "Account connected."
            : "Sign-in ended. You can start again."}
        </p>
      )}
    </div>
  )
}
