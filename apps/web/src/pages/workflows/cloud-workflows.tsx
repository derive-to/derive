import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { api } from "@/api"
import { ModelAccountPicker } from "@/components/accounts/model-account-picker"
import { EmptyState } from "@/components/shared/empty-state"
import { LoadError } from "@/components/shared/load-error"
import { StatusBadge } from "@/components/shared/status-badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { runtimeModelConnectionsQuery, workflowRuntimesQuery } from "@/lib/queries"
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
              disabled={!item.can_open}
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
  const accounts = useQuery(runtimeModelConnectionsQuery())
  const [name, setName] = useState("")
  const [accountId, setAccountId] = useState("")
  const selected = accounts.data?.items.find((account) => account.id === accountId)
  const canCreate = !!selected && !selected.unavailable_reason
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
        if (name.trim() && canCreate && !create.isPending) create.mutate()
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
      <ModelAccountPicker
        value={accountId}
        disabled={create.isPending}
        onChange={(account) => setAccountId(account.id)}
      />
      <Button
        data-testid="workflow-create-submit"
        type="submit"
        disabled={!name.trim() || !canCreate || create.isPending}
        loading={create.isPending}
      >
        Create workflow
      </Button>
    </form>
  )
}
