import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { api } from "@/api"
import { EmptyState } from "@/components/shared/empty-state"
import { LoadError } from "@/components/shared/load-error"
import { StatusBadge } from "@/components/shared/status-badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { workflowRuntimesQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"

export function CloudWorkflows() {
  const query = useQuery(workflowRuntimesQuery())
  if (query.isPending) return <Skeleton className="h-24 rounded-xl" />
  if (query.isError)
    return (
      <LoadError
        title="Couldn’t load cloud workflows"
        testId="cloud-workflows-retry"
        onRetry={() => query.refetch()}
      />
    )
  if (!query.data.items.length)
    return query.data.available ? (
      <EmptyState
        title="No cloud workflows yet"
        description="Create a workflow, choose its agent, and keep working files between runs."
      />
    ) : (
      <p className="text-sm text-muted-foreground">
        Cloud execution is in a limited pilot and is not available in this workspace. Existing task
        and GitHub workflows remain below.
      </p>
    )
  return (
    <div className="overflow-hidden rounded-xl border bg-card" data-testid="cloud-workflows-list">
      {query.data.items.map((item) => (
        <div
          key={item.id}
          className="flex flex-wrap items-center justify-between gap-4 border-b p-4 last:border-b-0"
        >
          <div className="min-w-0">
            <Link
              to="/workflows"
              search={{ workflow: item.id }}
              className="text-sm font-medium hover:underline"
              data-testid={`cloud-workflow-${item.id}`}
            >
              {item.name}
            </Link>
            <p className="mt-1 text-xs text-muted-foreground">
              {item.schedule?.trigger.kind === "schedule"
                ? item.schedule.enabled
                  ? `${item.schedule.trigger.cron} · ${item.schedule.trigger.tz}`
                  : "Schedule paused"
                : "On demand"}{" "}
              · Working files retained
            </p>
          </div>
          <StatusBadge
            tone={
              item.disabled || !item.can_open
                ? "muted"
                : item.preparing
                  ? "busy"
                  : item.ready
                    ? "ok"
                    : "attention"
            }
          >
            {item.disabled
              ? "Disabled"
              : !item.can_open
                ? "Execution unavailable"
                : item.preparing
                  ? "Preparing"
                  : item.ready
                    ? "Configured"
                    : "Setup needed"}
          </StatusBadge>
        </div>
      ))}
    </div>
  )
}

export function NewCloudWorkflow({ onCreated }: { onCreated: (id: string) => void }) {
  const accounts = useQuery({
    queryKey: ["runtime-model-connections"],
    queryFn: api.runtimeModelConnections,
  })
  const [name, setName] = useState("")
  const [accountId, setAccountId] = useState("")
  const [accountName, setAccountName] = useState("")
  const [provider, setProvider] = useState<"codex" | "claude-code">("codex")
  const add = useApiMutation({
    mutationFn: () => api.createRuntimeModelConnection(accountName.trim(), provider),
    invalidate: [["runtime-model-connections"]],
    onSuccess: (account) => setAccountId(account.id),
  })
  const create = useApiMutation({
    mutationFn: () =>
      api.createWorkflowRuntime({ name: name.trim(), model_connection_id: accountId }),
    invalidate: [workflowRuntimesQuery().queryKey],
    onSuccess: (value) => onCreated(value.id),
  })
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        if (name.trim() && accountId) create.mutate()
      }}
    >
      <p className="text-sm text-muted-foreground">
        Create a saved workflow with its own agent assignment and working files. Configure
        instructions and access next. Creating it does not start a run.
      </p>
      <label className="flex flex-col gap-1.5 text-sm">
        Workflow name
        <Input
          data-testid="workflow-create-name"
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
          placeholder="Daily integrity review"
          required
        />
      </label>
      {accounts.isError ? (
        <LoadError
          title="Couldn’t load accounts"
          testId="workflow-accounts-retry"
          onRetry={() => accounts.refetch()}
        />
      ) : (
        <label className="flex flex-col gap-1.5 text-sm">
          Agent account
          <select
            data-testid="workflow-create-account"
            className="h-9 rounded-lg border bg-background px-2 text-sm"
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            disabled={accounts.isPending}
            required
          >
            <option value="">Choose an account</option>
            {accounts.data?.items
              .filter((a) => !a.revoked_at)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} · {a.provider === "codex" ? "Codex" : "Claude Code"}
                </option>
              ))}
          </select>
        </label>
      )}
      <details>
        <summary className="cursor-pointer text-sm" data-testid="workflow-add-account">
          Add a model account
        </summary>
        <div className="mt-3 flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm">
            Account name
            <Input
              data-testid="workflow-account-name"
              value={accountName}
              maxLength={100}
              onChange={(e) => setAccountName(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Runner
            <select
              data-testid="workflow-account-provider"
              className="h-9 rounded-lg border bg-background px-2 text-sm"
              value={provider}
              onChange={(e) => setProvider(e.target.value as typeof provider)}
            >
              <option value="codex">Codex</option>
              <option value="claude-code">Claude Code</option>
            </select>
          </label>
          <Button
            type="button"
            variant="outline"
            data-testid="workflow-account-add"
            disabled={!accountName.trim() || add.isPending}
            loading={add.isPending}
            onClick={() => add.mutate()}
          >
            Add account
          </Button>
          <p className="text-xs text-muted-foreground">
            You’ll sign in on the workflow’s Configuration page.
          </p>
        </div>
      </details>
      <Button
        data-testid="workflow-create-submit"
        type="submit"
        disabled={!name.trim() || !accountId || create.isPending}
        loading={create.isPending}
      >
        Create workflow
      </Button>
    </form>
  )
}
