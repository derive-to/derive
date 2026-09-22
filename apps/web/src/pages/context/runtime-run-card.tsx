import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { api, type Connection } from "@/api"
import { LoadError } from "@/components/shared/load-error"
import { SectionTitle } from "@/components/shared/section-title"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { automationConnectionsQuery, contextRuntimeQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"

import { RuntimeScheduleCard } from "./runtime-schedule-card"

export function RuntimeRunCard({ contextId }: { contextId: string }) {
  const qc = useQueryClient()
  const query = contextRuntimeQuery(contextId)
  const state = useQuery(query)
  const connectionsQuery = automationConnectionsQuery()
  const connections = useQuery(connectionsQuery)
  const [sandbox, setSandbox] = useState("")
  const [connection, setConnection] = useState("")
  const [key, setKey] = useState("")
  const [instruction, setInstruction] = useState("")
  const [provider, setProvider] = useState<"codex" | "claude-code">("codex")
  const bind = useApiMutation({
    mutationFn: () => api.bindContextRuntime(contextId, connection, sandbox.trim()),
    invalidate: [query.queryKey],
    success: "Sandbox connected",
  })
  const saveKey = useApiMutation({
    mutationFn: async () => {
      await qc.cancelQueries({ queryKey: connectionsQuery.queryKey, exact: true })
      return api.createSecretConnection({
        toolkit: "ortam",
        secret: key.trim(),
        scopes_label: "Ortam controller",
      })
    },
    invalidate: [connectionsQuery.queryKey],
    success: "Ortam key saved",
    onSuccess: (saved) => {
      qc.setQueryData<Connection[]>(connectionsQuery.queryKey, (current) => [
        ...(current ?? []).filter((item) => item.id !== saved.id),
        saved,
      ])
      setConnection(saved.id)
      setKey("")
    },
  })
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
  if (state.isError)
    return (
      <LoadError
        title="Couldn’t load cloud runs"
        testId="context-runtime-runs-retry"
        onRetry={() => void state.refetch()}
      />
    )
  if (!state.data || (!state.data.enabled && !state.data.runtime)) return null
  const runtime = state.data.runtime
  return (
    <section className="flex flex-col gap-3 rounded-xl border bg-card p-3.5">
      <SectionTitle>Cloud runs</SectionTitle>
      {!runtime ? (
        <>
          <p className="text-xs text-muted-foreground">
            Connect a stopped Ortam sandbox with your model account attached. Set its auto-stop
            limit to 20 minutes or less and install this deployment’s runner. Choose a saved Ortam
            key or add one below.
          </p>
          {connections.isError && (
            <LoadError
              title="Couldn’t load saved connections"
              testId="context-runtime-connections-retry"
              onRetry={() => void connections.refetch()}
            />
          )}
          <label className="flex flex-col gap-1 text-sm">
            Ortam API connection
            <select
              data-testid="context-runtime-connection"
              className="rounded-md border bg-background p-2 text-sm"
              value={connection}
              onChange={(e) => setConnection(e.target.value)}
              disabled={
                connections.isPending || connections.isError || bind.isPending || saveKey.isPending
              }
            >
              <option value="">Choose a secret connection</option>
              {(connections.data ?? [])
                .filter((c) => c.kind === "secret" && c.status === "active")
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.scopes_label ?? c.toolkit}
                  </option>
                ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            New Ortam API key
            <Input
              data-testid="context-runtime-key"
              type="password"
              autoComplete="new-password"
              maxLength={4096}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              disabled={bind.isPending || saveKey.isPending}
            />
          </label>
          <p className="text-xs text-muted-foreground">
            Derive uses this key to start and stop your sandbox. It is stored encrypted and is not
            added to the agent’s environment.
          </p>
          <Button
            variant="outline"
            data-testid="context-runtime-key-save"
            disabled={!key.trim() || bind.isPending || saveKey.isPending}
            onClick={() => saveKey.mutate()}
          >
            {saveKey.isPending ? "Saving…" : "Save Ortam key"}
          </Button>
          <label className="flex flex-col gap-1 text-sm">
            Sandbox ID
            <Input
              data-testid="context-runtime-sandbox"
              value={sandbox}
              onChange={(e) => setSandbox(e.target.value)}
              placeholder="sbx_…"
              disabled={bind.isPending}
            />
          </label>
          <Button
            data-testid="context-runtime-bind"
            disabled={
              !connection || !sandbox.trim() || !!key.trim() || bind.isPending || saveKey.isPending
            }
            onClick={() => bind.mutate()}
          >
            Connect sandbox
          </Button>
        </>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            Working files survive shutdown and are reused on the next run. Reports are private to
            the person who starts the run.
          </p>
          {runtime.disabled_at ? (
            <p className="text-sm">Cloud runs are disabled.</p>
          ) : (
            <>
              <label className="flex flex-col gap-1 text-sm">
                Task
                <Textarea
                  data-testid="context-runtime-instruction"
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  maxLength={16000}
                  disabled={run.isPending}
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                Agent
                <select
                  data-testid="context-runtime-provider"
                  className="rounded-md border bg-background p-2 text-sm"
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
                disabled={!instruction.trim() || run.isPending || disable.isPending}
                onClick={() => run.mutate()}
              >
                Run now
              </Button>
              <Button
                variant="outline"
                data-testid="context-runtime-disable"
                disabled={disable.isPending}
                onClick={() => disable.mutate()}
              >
                Disable cloud runs
              </Button>
              <RuntimeScheduleCard
                contextId={contextId}
                schedule={state.data.schedule ?? null}
                nextRunAt={state.data.next_run_at ?? null}
              />
            </>
          )}
          {state.data.runs.map((item) => {
            const details = item.meta ? JSON.parse(item.meta).runtime : null
            return (
              <div key={item.id} className="flex flex-col gap-1 border-t pt-2 text-sm">
                <span>
                  {new Date(item.created_at).toLocaleString()} · {item.status}
                </span>
                {item.attempt && (
                  <span className="text-xs text-muted-foreground">
                    {item.attempt.result_json ? "Report received" : "Awaiting report"} ·{" "}
                    {item.attempt.released_at
                      ? "Sandbox stopped"
                      : item.attempt.phase === "stopping"
                        ? "Waiting for shutdown confirmation"
                        : item.attempt.phase}
                  </span>
                )}
                {item.attempt?.result_json && !details?.report_short_id && (
                  <details>
                    <summary
                      className="cursor-pointer text-primary"
                      data-testid={`context-runtime-receipt-${item.id}`}
                    >
                      Read received report
                    </summary>
                    <p className="whitespace-pre-wrap text-sm">
                      {JSON.parse(item.attempt.result_json).summary}
                    </p>
                  </details>
                )}
                {details?.report_short_id && (
                  <a
                    href={`/artifacts/${details.report_short_id}`}
                    className="text-primary underline"
                    data-testid={`context-runtime-report-${item.id}`}
                  >
                    Open report
                  </a>
                )}
              </div>
            )
          })}
        </>
      )}
    </section>
  )
}
