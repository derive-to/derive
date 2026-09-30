import { useQuery } from "@tanstack/react-query"
import { api } from "@/api"
import { LoadError } from "@/components/shared/load-error"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { automationsQuery, workspaceQuery, workspaceSettingsQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"

/** The one brake, visible at the point of use: when agent writes are paused nothing runs, so say
 *  so here instead of letting a run button lead to a wall. Rollout and account access are separate. */
export function ExecutionReadiness({ cloud = false }: { cloud?: boolean }) {
  const workspace = useQuery(workspaceQuery())
  const settings = useQuery(workspaceSettingsQuery())
  const enable = useApiMutation({
    mutationFn: () => api.updateWorkspaceSettings({ agentWrites: true }),
    invalidate: [workspaceSettingsQuery().queryKey, automationsQuery().queryKey],
    success: "Agent writes turned on",
  })
  if (workspace.isError || settings.isError)
    return (
      <LoadError
        title="Couldn’t check execution permissions"
        testId="workflow-readiness-retry"
        layout="inline"
        onRetry={() => {
          void workspace.refetch()
          void settings.refetch()
        }}
      />
    )
  if (!settings.data || !workspace.data) return <Skeleton className="h-20 rounded-lg" />
  if (settings.data.agentWrites) return null
  const owner = workspace.data.role === "owner"
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-4 rounded-xl border bg-card p-4"
      data-testid="workflow-readiness"
    >
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">Agent writes are paused</p>
        <p className="max-w-xl text-sm text-muted-foreground">
          {owner
            ? "Nothing an agent does will run or publish in this workspace until agent writes are back on. Turning them on does not start any work."
            : "A workspace owner has paused agent writes. Nothing will run until they turn them back on."}
        </p>
      </div>
      {owner && (
        <Button
          data-testid={cloud ? "workflows-enable-cloud" : "automations-enable"}
          variant="secondary"
          size="sm"
          loading={enable.isPending}
          disabled={enable.isPending}
          onClick={() => enable.mutate()}
        >
          Turn agent writes on
        </Button>
      )}
    </div>
  )
}
