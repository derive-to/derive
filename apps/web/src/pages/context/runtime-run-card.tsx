import type { UseQueryResult } from "@tanstack/react-query"
import { useState } from "react"
import { api } from "@/api"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { LoadError } from "@/components/shared/load-error"
import { SectionHeading, SectionTitle } from "@/components/shared/section-title"
import { StatusBadge } from "@/components/shared/status-badge"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { contextRuntimeQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import { ManagedRuntimeCard } from "./managed-runtime-card"
import { RuntimeRunHistory } from "./runtime-run-history"
import { RuntimeScheduleCard } from "./runtime-schedule-card"
import { RuntimeSetup } from "./runtime-setup"

export function RuntimeRunCard({
  contextId,
  state,
}: {
  contextId: string
  state: UseQueryResult<Awaited<ReturnType<typeof api.getContextRuntime>>>
}) {
  const query = contextRuntimeQuery(contextId)
  const [instruction, setInstruction] = useState("")
  const [provider, setProvider] = useState<"codex" | "claude-code">("codex")
  const [confirmDisable, setConfirmDisable] = useState(false)
  const run = useApiMutation({
    mutationFn: () => api.runContextRuntime(contextId, instruction.trim(), provider),
    invalidate: [query.queryKey],
    success: "Run queued",
    onSuccess: () => setInstruction(""),
  })
  const disable = useApiMutation({
    mutationFn: () => api.disableContextRuntime(contextId),
    invalidate: [query.queryKey],
    success: "New runs disabled; active runs will stop",
  })
  if (!state.data?.enabled) return null
  if (state.data.managed) return <ManagedRuntimeCard contextId={contextId} state={state.data} />
  const runtime = state.data.runtime
  return (
    <section data-testid="context-runtime-panel" className="flex max-w-4xl flex-col gap-8">
      {state.isError && (
        <LoadError
          title="Couldn’t refresh cloud runs"
          testId="context-runtime-runs-retry"
          onRetry={() => void state.refetch()}
        />
      )}
      <div className="flex flex-col gap-2">
        <SectionHeading
          as="h2"
          action={
            <StatusBadge tone="muted">
              {runtime ? (runtime.disabled_at ? "Disabled" : "Connected") : "Not connected"}
            </StatusBadge>
          }
        >
          {runtime ? "Cloud runs" : "Connect a sandbox"}
        </SectionHeading>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Operator pilot: provision a sandbox and attach your model account in Ortam. Working files
          are saved after each run and reused next time.
        </p>
      </div>
      {!runtime ? (
        <RuntimeSetup contextId={contextId} setup={state.data.setup ?? null} />
      ) : (
        <>
          {runtime.disabled_at ? (
            <p className="text-sm text-muted-foreground">
              Cloud runs are disabled. Previous reports remain available below.
            </p>
          ) : (
            <div className="grid items-start gap-5 lg:grid-cols-2">
              <div className="flex min-w-0 flex-col gap-4 rounded-xl border bg-card p-5">
                <div className="flex flex-col gap-1">
                  <SectionTitle>Run a task</SectionTitle>
                  <p className="text-sm text-muted-foreground">
                    Start a one-time task with your saved files.
                  </p>
                </div>
                <label className="flex flex-col gap-1.5 text-sm">
                  Instructions
                  <Textarea
                    data-testid="context-runtime-instruction"
                    value={instruction}
                    onChange={(e) => setInstruction(e.target.value)}
                    placeholder="Run the daily checks and summarize anything unusual…"
                    className="min-h-28"
                    maxLength={16000}
                    disabled={run.isPending}
                  />
                </label>
                <div className="flex flex-wrap items-end justify-between gap-3">
                  <label className="flex flex-col gap-1.5 text-sm">
                    Agent
                    <select
                      data-testid="context-runtime-provider"
                      className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm focus-visible:outline-2 focus-visible:outline-ring"
                      value={provider}
                      onChange={(e) => setProvider(e.target.value as "codex" | "claude-code")}
                      disabled={run.isPending}
                    >
                      <option value="codex">Codex</option>
                      <option value="claude-code">Claude Code</option>
                    </select>
                  </label>
                  <Button
                    data-testid="context-runtime-run"
                    loading={run.isPending}
                    disabled={!instruction.trim() || run.isPending || disable.isPending}
                    onClick={() => run.mutate()}
                  >
                    {run.isPending ? "Queuing…" : "Run now"}
                  </Button>
                </div>
                <p className="text-sm text-muted-foreground">
                  Reports are private to the person who starts the run.
                </p>
              </div>
              <RuntimeScheduleCard
                contextId={contextId}
                schedule={state.data.schedule ?? null}
                nextRunAt={state.data.next_run_at ?? null}
              />
            </div>
          )}
          <div className="flex flex-col gap-4">
            <SectionHeading count={state.data.runs.length}>Recent runs</SectionHeading>
            <RuntimeRunHistory runs={state.data.runs} />
          </div>
          {!runtime.disabled_at && (
            <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
              <span className="min-w-0 break-all font-mono text-xs">{runtime.sandbox_id}</span>
              <Button
                variant="ghost"
                size="sm"
                data-testid="context-runtime-disable"
                disabled={disable.isPending}
                onClick={() => setConfirmDisable(true)}
              >
                Disable cloud runs…
              </Button>
            </div>
          )}
          <ConfirmDialog
            open={confirmDisable}
            onOpenChange={setConfirmDisable}
            title="Disable cloud runs?"
            description="This stops active work and prevents new runs. You cannot re-enable this sandbox from Derive yet. Saved reports remain available."
            confirmLabel="Disable cloud runs"
            onConfirm={async () => {
              await disable.mutateAsync()
            }}
          />
        </>
      )}
    </section>
  )
}
