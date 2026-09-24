import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { api } from "@/api"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { LoadError } from "@/components/shared/load-error"
import { SectionTitle } from "@/components/shared/section-title"
import { Button } from "@/components/ui/button"
import { contextRuntimeQuery, workflowRuntimesQuery, workspaceSettingsQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import { ExecutionReadiness } from "../workflows/execution-readiness"
import { RuntimeModelAccount } from "./runtime-model-account"
import { RuntimeRunHistory } from "./runtime-run-history"
import { RuntimeScheduleCard } from "./runtime-schedule-card"

type RuntimeState = Awaited<ReturnType<typeof api.getContextRuntime>>

export function ManagedRuntimeCard({
  contextId,
  state,
  view = "all",
}: {
  contextId: string
  state: RuntimeState
  view?: "all" | "configuration" | "runs"
}) {
  const [confirmDisable, setConfirmDisable] = useState(false)
  const settings = useQuery(workspaceSettingsQuery())
  const executionEnabled = !!settings.data?.hostedAgentsEnabled && !!settings.data?.agentWrites
  const queryKey = contextRuntimeQuery(contextId).queryKey
  const setup = useApiMutation({
    mutationFn: () => api.setupContextRuntime(contextId),
    invalidate: [queryKey, workflowRuntimesQuery().queryKey],
    success: "Preparing your workspace",
  })
  const cancel = useApiMutation({
    mutationFn: () => api.cancelContextRuntimeSetup(contextId),
    invalidate: [queryKey, workflowRuntimesQuery().queryKey],
    success: "Setup cancelled",
  })
  const run = useApiMutation({
    mutationFn: () => api.runSavedRuntimeJob(contextId),
    invalidate: [queryKey, workflowRuntimesQuery().queryKey],
    success: "Run queued",
  })
  const disable = useApiMutation({
    mutationFn: () => api.disableContextRuntime(contextId),
    invalidate: [queryKey, workflowRuntimesQuery().queryKey],
    success: "Cloud runs disabled",
  })
  const ready = state.runtime && !state.runtime.disabled_at
  const job = state.schedule
  return (
    <div className="flex flex-col gap-6">
      {settings.isError ? (
        <LoadError
          title="Couldn’t check execution settings"
          testId="workflow-cloud-settings-retry"
          onRetry={() => settings.refetch()}
        />
      ) : (
        <ExecutionReadiness cloud />
      )}
      {view !== "runs" && (
        <>
          <div className="flex flex-col gap-1">
            <SectionTitle>Agent and execution</SectionTitle>
            <p className="text-sm text-muted-foreground">
              Your agent keeps its files between runs. Anyone with permission to run this workflow
              uses its saved agent and tools.
            </p>
          </div>
          <RuntimeModelAccount key={contextId} contextId={contextId} canEdit={!!state.can_edit} />
          {!state.runtime && (
            <div className="flex flex-col gap-3 rounded-xl border bg-card p-5">
              {!state.setup ? (
                <>
                  <p className="text-sm text-muted-foreground">
                    Connect a model account, then prepare the workspace for this workflow.
                  </p>
                  {state.can_edit && (
                    <Button
                      data-testid="context-managed-setup"
                      className="self-start"
                      disabled={
                        !executionEnabled ||
                        !state.model_connection ||
                        state.model_connection.revoked
                      }
                      loading={setup.isPending}
                      onClick={() => setup.mutate()}
                    >
                      Prepare workflow
                    </Button>
                  )}
                </>
              ) : (
                <>
                  <p className="text-sm">
                    {state.setup.phase === "failed"
                      ? "Preparation failed. Your configuration is kept. Contact a workspace owner to recover this workspace."
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
        </>
      )}
      {ready && (
        <>
          {state.can_edit && view !== "runs" && (
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
                  : job && JSON.parse(job.trigger).kind === "schedule"
                    ? "Schedule paused · Run now is available"
                    : "On demand"}
              </p>
              {(!state.model_connection ||
                state.model_connection.revoked ||
                state.model_connection.provider !== job.provider) && (
                <p className="text-sm text-muted-foreground">
                  Select and connect the matching agent account in Configuration before running.
                </p>
              )}
              <Button
                data-testid="context-managed-run"
                className="self-start"
                disabled={
                  !executionEnabled ||
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
          {state.can_edit && view !== "runs" && (
            <Button
              data-testid="context-managed-disable"
              variant="outline"
              className="self-start"
              loading={disable.isPending}
              onClick={() => setConfirmDisable(true)}
            >
              Disable cloud runs
            </Button>
          )}
        </>
      )}
      <ConfirmDialog
        open={confirmDisable}
        onOpenChange={setConfirmDisable}
        title="Disable cloud execution?"
        description="This stops active work and prevents new runs. Re-enabling this workspace is not supported yet. Existing reports remain available."
        confirmLabel="Disable cloud execution"
        onConfirm={() => disable.mutateAsync().then(() => undefined)}
      />
      {view !== "configuration" && (
        <div className="flex flex-col gap-3">
          <SectionTitle>Recent runs</SectionTitle>
          <RuntimeRunHistory runs={state.runs} />
        </div>
      )}
    </div>
  )
}
