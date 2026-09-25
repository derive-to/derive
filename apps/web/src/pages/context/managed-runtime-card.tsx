import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { type ReactNode, useRef, useState } from "react"
import { api } from "@/api"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { LoadError } from "@/components/shared/load-error"
import { SectionTitle } from "@/components/shared/section-title"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import {
  contextRuntimeQuery,
  workflowConfigurationQuery,
  workflowRuntimesQuery,
} from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import { RuntimeModelAccount } from "./runtime-model-account"
import { RuntimeRunHistory } from "./runtime-run-history"
import { RuntimeScheduleCard } from "./runtime-schedule-card"

type RuntimeState = Awaited<ReturnType<typeof api.getContextRuntime>>
export function ManagedRuntimeCard({
  contextId,
  state,
  view = "all",
  access,
}: {
  contextId: string
  state: RuntimeState
  access?: ReactNode
  view?: "all" | "configuration" | "runs"
}) {
  const configuration = useQuery({
    ...workflowConfigurationQuery(contextId),
    refetchInterval: 5000,
  })
  const [scheduleDirty, setScheduleDirty] = useState(false)
  const [confirmDisable, setConfirmDisable] = useState(false)
  const testRequest = useRef<{ revision: string; id: string } | null>(null)
  const [draft, setDraft] = useState<{
    instruction: string
    provider: "codex" | "claude-code"
    revision: number | null
  } | null>(null)
  const saved = configuration.data?.draft
  const values = draft ?? {
    instruction: saved?.instruction ?? "",
    provider: saved?.provider ?? "codex",
    revision: saved?.revision ?? null,
  }
  const stale = !!draft && draft.revision !== (saved?.revision ?? null)
  const invalidate = [contextRuntimeQuery(contextId).queryKey, workflowRuntimesQuery().queryKey]
  const save = useApiMutation({
    mutationFn: () => api.saveWorkflowDraft(contextId, values),
    invalidate,
    success: "Draft saved",
    onSuccess: () => setDraft(null),
  })
  const run = useApiMutation({
    mutationFn: (revision: string) => {
      if (!testRequest.current || testRequest.current.revision !== revision)
        testRequest.current = { revision, id: crypto.randomUUID() }
      return api.testWorkflow(contextId, revision, testRequest.current.id)
    },
    invalidate,
    success: "Test requested. You can leave this page while it prepares and runs.",
    onSuccess: () => {
      testRequest.current = null
    },
  })
  const cancel = useApiMutation({
    mutationFn: () => api.cancelContextRuntimeSetup(contextId),
    invalidate,
    success: "Preparation cancelled",
  })
  const disable = useApiMutation({
    mutationFn: () => api.disableContextRuntime(contextId),
    invalidate,
    success: "Cloud runs disabled",
  })
  const readiness = configuration.data?.readiness
  const firstBlocker = readiness?.blockers[0]
  const nextAction =
    firstBlocker?.action && firstBlocker.action !== "settings" && firstBlocker.action !== "retry"
      ? firstBlocker
      : null
  return (
    <div className="flex flex-col gap-6">
      {configuration.isError && (
        <LoadError
          title="Couldn’t check this workflow"
          testId="workflow-readiness-retry"
          onRetry={() => configuration.refetch()}
        />
      )}
      {configuration.data?.test?.status === "failed" && (
        <p className="text-sm text-muted-foreground" role="status">
          The last test could not start. Your configuration is saved. Review the issues below, then
          test again.
        </p>
      )}
      {readiness && (
        <div
          className="flex flex-col gap-3 rounded-xl border bg-card p-5"
          data-testid="workflow-readiness"
        >
          <SectionTitle>
            {readiness.state.charAt(0).toUpperCase() +
              readiness.state.slice(1).replaceAll("_", " ")}
          </SectionTitle>
          {readiness.blockers.map((blocker) => (
            <p key={blocker.code} className="text-sm text-muted-foreground">
              {blocker.message}
              {blocker.action === "settings" && (
                <>
                  {" "}
                  <Link to="/settings" className="text-primary underline">
                    Workspace settings
                  </Link>
                </>
              )}
            </p>
          ))}
          {readiness.state === "preparing" && (
            <p className="text-sm text-muted-foreground">
              Preparing your workflow. The requested test will run automatically. You can leave and
              return.
            </p>
          )}
          {(draft || scheduleDirty) && (
            <p className="text-sm text-muted-foreground">Save your edits before testing.</p>
          )}
          {!readiness.can_test && nextAction && (
            <Link
              to="/workflows"
              search={{ workflow: contextId, tab: "configuration" }}
              hash={
                nextAction?.action === "account"
                  ? "workflow-account"
                  : nextAction?.action === "access"
                    ? "workflow-access"
                    : "workflow-instructions"
              }
              className="text-sm text-primary underline"
              data-testid="workflow-next-action"
            >
              {nextAction?.action === "account"
                ? "Review model account"
                : nextAction?.action === "access"
                  ? "Review access"
                  : "Edit instructions"}
            </Link>
          )}
          <Button
            data-testid="context-managed-run"
            className="self-start"
            disabled={!readiness.can_test || !!draft || scheduleDirty || run.isPending}
            loading={run.isPending}
            onClick={() => run.mutate(readiness.revision)}
          >
            Test run
          </Button>
          {readiness.can_edit &&
            state.setup &&
            !state.setup.cancelled_at &&
            !["failed", "ready", "binding", "deleting"].includes(state.setup.phase) && (
              <Button
                data-testid="context-managed-cancel"
                variant="outline"
                className="self-start"
                loading={cancel.isPending}
                onClick={() => cancel.mutate()}
              >
                Cancel preparation
              </Button>
            )}
        </div>
      )}
      {view !== "runs" && (
        <>
          {(!state.schedule || draft) && readiness?.can_edit && (
            <div className="flex flex-col gap-4 rounded-xl border bg-card p-5">
              <div id="workflow-instructions">
                <SectionTitle>Instructions</SectionTitle>
              </div>
              <label className="flex flex-col gap-2 text-sm">
                What should this workflow do?
                <Textarea
                  data-testid="workflow-draft-instruction"
                  value={values.instruction}
                  maxLength={16000}
                  className="min-h-28"
                  onChange={(e) => setDraft({ ...values, instruction: e.target.value })}
                />
              </label>
              <label className="flex flex-col gap-2 text-sm">
                Runner
                <select
                  data-testid="workflow-draft-provider"
                  className="h-8 rounded-lg border border-input bg-background px-2 text-sm"
                  value={values.provider}
                  onChange={(e) =>
                    setDraft({ ...values, provider: e.target.value as "codex" | "claude-code" })
                  }
                >
                  <option value="codex">Codex</option>
                  <option value="claude-code">Claude Code</option>
                </select>
              </label>
              {stale && (
                <p className="text-sm text-muted-foreground">
                  Configuration changed elsewhere. Your edits are kept. Reload the saved version
                  before editing again.
                </p>
              )}
              <div className="flex gap-2">
                <Button
                  data-testid="workflow-draft-save"
                  className="self-start"
                  loading={save.isPending}
                  disabled={stale || save.isPending}
                  onClick={() => save.mutate()}
                >
                  Save draft
                </Button>
                {stale && (
                  <Button
                    data-testid="workflow-draft-reload"
                    variant="outline"
                    onClick={() => setDraft(null)}
                  >
                    Discard edits and reload
                  </Button>
                )}
              </div>
            </div>
          )}
          {state.schedule && !draft && readiness?.can_edit && (
            <RuntimeScheduleCard
              contextId={contextId}
              fixedProvider={state.model_connection?.provider}
              schedule={state.schedule}
              nextRunAt={state.next_run_at}
              onDirtyChange={setScheduleDirty}
            />
          )}
          <div className="flex flex-col gap-2 rounded-xl border bg-card p-5">
            <SectionTitle>Files</SectionTitle>
            <p className="text-sm text-muted-foreground">
              Start with instructions alone. Files created by this workflow are retained between
              runs. Uploading a local project and custom setup commands are not available yet.
            </p>
            <Link
              to="/contexts/$id"
              params={{ id: contextId }}
              className="text-sm text-primary underline"
              data-testid="workflow-files-skills"
            >
              Manage supporting artifacts and skills
            </Link>
          </div>
          <SectionTitle>Account &amp; access</SectionTitle>
          {state.enabled && (readiness?.can_edit || state.model_connection) && (
            <div id="workflow-account">
              <RuntimeModelAccount contextId={contextId} canEdit={!!readiness?.can_edit} />
            </div>
          )}
          {access && <div id="workflow-access">{access}</div>}
          {!state.schedule && (
            <p className="text-sm text-muted-foreground">
              On demand · Add a schedule after the first test is prepared. Test reports are private
              to the person who requests them.
            </p>
          )}
          {state.runtime && readiness?.can_edit && (
            <details className="text-sm">
              <summary data-testid="workflow-advanced" className="cursor-pointer">
                Advanced
              </summary>
              <Button
                data-testid="context-managed-disable"
                variant="outline"
                className="mt-3"
                onClick={() => setConfirmDisable(true)}
              >
                Disable cloud runs
              </Button>
            </details>
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
