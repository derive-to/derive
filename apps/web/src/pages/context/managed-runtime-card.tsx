import { api } from "@/api"
import { SectionTitle } from "@/components/shared/section-title"
import { Button } from "@/components/ui/button"
import { contextRuntimeQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import { RuntimeModelAccount } from "./runtime-model-account"
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
      <RuntimeModelAccount key={contextId} contextId={contextId} canEdit={!!state.can_edit} />
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
                  disabled={!state.model_connection || state.model_connection.revoked}
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
              fixedProvider={state.model_connection?.provider}
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
                disabled={
                  job.enabled !== 1 ||
                  !state.model_connection ||
                  state.model_connection.revoked ||
                  state.model_connection.provider !== job.provider
                }
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
