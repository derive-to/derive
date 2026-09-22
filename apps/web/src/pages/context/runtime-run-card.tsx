import type { RunAttemptPhase } from "@derive/core"
import type { UseQueryResult } from "@tanstack/react-query"
import { useState } from "react"
import { api } from "@/api"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { EmptyState } from "@/components/shared/empty-state"
import { LoadError } from "@/components/shared/load-error"
import { SectionHeading, SectionTitle } from "@/components/shared/section-title"
import { StatusBadge } from "@/components/shared/status-badge"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { contextRuntimeQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import { RuntimeScheduleCard } from "./runtime-schedule-card"
import { RuntimeSetup } from "./runtime-setup"

const attemptLabel: Record<RunAttemptPhase, string> = {
  starting: "Starting sandbox",
  ready: "Sandbox ready",
  launching: "Starting agent",
  running: "Agent running",
  stopping: "Waiting for shutdown confirmation",
  released: "Sandbox stopped",
}

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
            {state.data.runs.length === 0 && (
              <EmptyState
                title="No runs yet"
                description="Run a task or start a schedule. Reports and sandbox status will appear here."
              />
            )}
            {state.data.runs.map((item) => {
              const details = item.meta ? JSON.parse(item.meta).runtime : null
              return (
                <div
                  key={item.id}
                  className="flex flex-col gap-2 rounded-lg border bg-card p-4 text-sm"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <time
                      dateTime={item.created_at}
                      className="font-mono text-xs text-muted-foreground"
                    >
                      {new Date(item.created_at).toLocaleString()}
                    </time>
                    <StatusBadge
                      tone={
                        item.status === "succeeded"
                          ? "ok"
                          : item.status === "failed"
                            ? "error"
                            : item.status === "running"
                              ? "busy"
                              : "muted"
                      }
                    >
                      {item.status === "succeeded"
                        ? "Completed"
                        : item.status.charAt(0).toUpperCase() + item.status.slice(1)}
                    </StatusBadge>
                  </div>
                  {item.attempt && (
                    <p className="text-sm text-muted-foreground">
                      {item.attempt.result_json ? "Report received" : "Awaiting report"} ·{" "}
                      {item.attempt.released_at
                        ? "Sandbox stopped"
                        : attemptLabel[item.attempt.phase]}
                    </p>
                  )}
                  {item.attempt?.result_json && !details?.report_short_id && (
                    <details>
                      <summary
                        className="cursor-pointer text-primary"
                        data-testid={`context-runtime-receipt-${item.id}`}
                      >
                        Read received report
                      </summary>
                      <p className="mt-3 whitespace-pre-wrap text-sm">
                        {JSON.parse(item.attempt.result_json).summary}
                      </p>
                    </details>
                  )}
                  {details?.report_short_id && (
                    <a
                      href={`/artifacts/${details.report_short_id}`}
                      className="text-primary underline underline-offset-4"
                      data-testid={`context-runtime-report-${item.id}`}
                    >
                      Open report
                    </a>
                  )}
                </div>
              )
            })}
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
