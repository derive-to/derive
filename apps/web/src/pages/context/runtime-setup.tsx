import type { RuntimeSetupRecord } from "@derive/core"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { api, type Connection } from "@/api"
import { LoadError } from "@/components/shared/load-error"
import { SectionTitle } from "@/components/shared/section-title"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { automationConnectionsQuery, contextRuntimeQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"

export function RuntimeSetup({
  contextId,
  setup,
}: {
  contextId: string
  setup: RuntimeSetupRecord | null
}) {
  return setup ? (
    <RuntimeSetupProgress contextId={contextId} setup={setup} />
  ) : (
    <RuntimeSetupForm contextId={contextId} />
  )
}

function RuntimeSetupProgress({
  contextId,
  setup,
}: {
  contextId: string
  setup: RuntimeSetupRecord
}) {
  const cancel = useApiMutation({
    mutationFn: () => api.cancelContextRuntimeSetup(contextId),
    invalidate: [contextRuntimeQuery(contextId).queryKey],
    success: "Setup cancellation requested",
  })
  const labels: Record<RuntimeSetupRecord["phase"], string> = {
    queued: "Waiting to set up your sandbox",
    creating: "Creating your sandbox",
    provisioning: "Installing the runner",
    stopping: "Saving your sandbox",
    awaiting_connection: "Attach your model account",
    binding: "Connecting your sandbox",
    ready: "Sandbox connected",
    deleting: "Removing the unfinished sandbox",
    failed: "Setup ended",
  }
  return (
    <div className="flex flex-col gap-4 rounded-xl border bg-card p-5">
      <SectionTitle>
        {setup.cancelled_at && setup.phase !== "failed" ? "Cancelling setup" : labels[setup.phase]}
      </SectionTitle>
      <p className="text-sm text-muted-foreground">
        {setup.phase === "failed"
          ? "No runtime was connected. Any sandbox created by this setup has been deleted. Use a new Context to try again."
          : setup.phase === "awaiting_connection" && !setup.cancelled_at
            ? "Open this sandbox’s settings in Ortam and choose Attach my connections. Keep the sandbox stopped; Derive will connect it automatically."
            : "Derive checks progress every minute. You can leave this page while setup or cleanup continues."}
      </p>
      {setup.sandbox_id && setup.phase === "awaiting_connection" && !setup.cancelled_at && (
        <p className="break-all font-mono text-sm">{setup.sandbox_id}</p>
      )}
      {!setup.cancelled_at && !["failed", "ready", "deleting", "binding"].includes(setup.phase) && (
        <>
          <p className="text-sm text-muted-foreground">
            Finish setup by {new Date(setup.deadline_at).toLocaleTimeString()}. Incomplete setups
            are removed automatically.
          </p>
          <Button
            variant="outline"
            className="self-start"
            data-testid="context-runtime-setup-cancel"
            disabled={cancel.isPending}
            onClick={() => cancel.mutate()}
          >
            Cancel setup
          </Button>
        </>
      )}
    </div>
  )
}

function RuntimeSetupForm({ contextId }: { contextId: string }) {
  const qc = useQueryClient()
  const query = contextRuntimeQuery(contextId)
  const connectionsQuery = automationConnectionsQuery()
  const connections = useQuery(connectionsQuery)
  const [sandbox, setSandbox] = useState("")
  const [connection, setConnection] = useState("")
  const [key, setKey] = useState("")
  const bind = useApiMutation({
    mutationFn: () => api.bindContextRuntime(contextId, connection, sandbox.trim()),
    invalidate: [query.queryKey],
    success: "Sandbox connected",
  })
  const provision = useApiMutation({
    mutationFn: () => api.setupContextRuntime(contextId, connection),
    invalidate: [query.queryKey],
    success: "Sandbox setup queued",
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
  return (
    <div className="grid gap-8 rounded-xl border bg-card p-5 sm:grid-cols-2 sm:p-6">
      <div className="flex min-w-0 flex-col gap-4">
        <SectionTitle>Ortam connection</SectionTitle>
        <p className="text-sm text-muted-foreground">
          Choose a saved key or add one from your Ortam account.
        </p>
        {connections.isError && (
          <LoadError
            title="Couldn’t load saved connections"
            testId="context-runtime-connections-retry"
            onRetry={() => void connections.refetch()}
          />
        )}
        <label className="flex flex-col gap-1.5 text-sm">
          Ortam API connection
          <select
            data-testid="context-runtime-connection"
            className="h-8 min-w-0 rounded-lg border border-input bg-transparent px-2 text-sm focus-visible:outline-2 focus-visible:outline-ring"
            value={connection}
            onChange={(e) => setConnection(e.target.value)}
            disabled={
              connections.isPending ||
              connections.isError ||
              bind.isPending ||
              provision.isPending ||
              saveKey.isPending
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
        <label className="flex flex-col gap-1.5 text-sm">
          New Ortam API key
          <Input
            data-testid="context-runtime-key"
            type="password"
            autoComplete="new-password"
            maxLength={4096}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            disabled={bind.isPending || provision.isPending || saveKey.isPending}
          />
        </label>
        <p className="text-sm text-muted-foreground">
          Derive uses this key to start and stop your sandbox. It is stored encrypted and is not
          added to the agent’s environment.
        </p>
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          loading={saveKey.isPending}
          data-testid="context-runtime-key-save"
          disabled={!key.trim() || bind.isPending || provision.isPending || saveKey.isPending}
          onClick={() => saveKey.mutate()}
        >
          {saveKey.isPending ? "Saving…" : "Save Ortam key"}
        </Button>
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        <SectionTitle>Create a sandbox</SectionTitle>
        <p className="text-sm text-muted-foreground">
          Derive creates a Small sandbox, installs the runner, and sets a 20-minute auto-stop limit.
          Ortam usage is billed to your account. You’ll then attach your model account in Ortam.
        </p>
        <Button
          className="self-start"
          data-testid="context-runtime-provision"
          loading={provision.isPending}
          disabled={
            !connection ||
            !!key.trim() ||
            provision.isPending ||
            bind.isPending ||
            saveKey.isPending
          }
          onClick={() => provision.mutate()}
        >
          Create sandbox
        </Button>
        <SectionTitle>Use an existing sandbox</SectionTitle>
        <p className="text-sm text-muted-foreground">
          Connect the sandbox that will keep this Context’s working files.
        </p>
        <label className="flex flex-col gap-1.5 text-sm">
          Sandbox ID
          <Input
            data-testid="context-runtime-sandbox"
            value={sandbox}
            onChange={(e) => setSandbox(e.target.value)}
            placeholder="sbx_…"
            disabled={bind.isPending || provision.isPending}
          />
        </label>
        <div className="rounded-lg bg-secondary p-3 text-sm text-muted-foreground">
          <p className="mb-2 font-medium text-foreground">Before connecting</p>
          <ul className="list-disc space-y-1 pl-4">
            <li>Attach your Codex or Claude account in Ortam.</li>
            <li>Install this deployment’s Derive runner.</li>
            <li>Set auto-stop to 20 minutes or less, then stop the sandbox.</li>
          </ul>
        </div>
        <Button
          className="self-start"
          loading={bind.isPending}
          data-testid="context-runtime-bind"
          disabled={
            !connection ||
            !sandbox.trim() ||
            !!key.trim() ||
            bind.isPending ||
            provision.isPending ||
            saveKey.isPending
          }
          onClick={() => bind.mutate()}
        >
          {bind.isPending ? "Connecting…" : "Connect sandbox"}
        </Button>
      </div>
    </div>
  )
}
