import { useQuery } from "@tanstack/react-query"
import { api } from "@/api"
import { LoadError } from "@/components/shared/load-error"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { automationsQuery, workspaceQuery, workspaceSettingsQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"

/** Workspace consent is visible at the point of use. Rollout and account access remain separate. */
export function ExecutionReadiness({ cloud = false }: { cloud?: boolean }) {
  const workspace = useQuery(workspaceQuery())
  const settings = useQuery(workspaceSettingsQuery())
  const enable = useApiMutation({
    mutationFn: () =>
      api.updateWorkspaceSettings(
        cloud ? { hostedAgentsEnabled: true, agentWrites: true } : { automateBeta: true },
      ),
    invalidate: [workspaceSettingsQuery().queryKey, automationsQuery().queryKey],
    success: "Workflow execution enabled",
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
  const enabled = cloud
    ? settings.data.hostedAgentsEnabled && settings.data.agentWrites
    : settings.data.automateBeta
  if (enabled) return null
  const owner = workspace.data.role === "owner"
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-4 rounded-xl border bg-card p-4"
      data-testid="workflow-readiness"
    >
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">
          {cloud ? "Cloud execution is off" : "Automated execution is off"}
        </p>
        <p className="max-w-xl text-sm text-muted-foreground">
          {owner
            ? cloud
              ? "Enable hosted agents and artifact writes for this workspace. This allows authorized cloud runs; it does not start any work."
              : "Enable automation triggers and direct task execution for this workspace. This does not start a workflow or schedule."
            : "A workspace owner must enable execution before you can run this workflow."}
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
          Enable {cloud ? "cloud execution" : "workflows"}
        </Button>
      )}
    </div>
  )
}
