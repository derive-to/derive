import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { api, type GithubIntegrationAccount } from "@/api"
import { AdminNote } from "@/components/shared/admin-note"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { ListRow } from "@/components/shared/list-row"
import { LoadError } from "@/components/shared/load-error"
import { SettingsGroup } from "@/components/shared/settings-group"
import { StatusBadge } from "@/components/shared/status-badge"
import { StatusPanel } from "@/components/shared/status-panel"
import { Button } from "@/components/ui/button"
import {
  connectionsQuery,
  githubQuery,
  githubRepositoriesQuery,
  workspaceQuery,
} from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import { useOneShotParams } from "@/lib/use-one-shot-params"
import { SettingsListSkeleton } from "./settings-list-skeleton"

const INSTALL_MESSAGES: Record<string, { title: string; description: string }> = {
  requested: {
    title: "Waiting for organization approval",
    description:
      "A GitHub organization owner must approve your request. Connect again after approval.",
  },
  canceled: {
    title: "GitHub connection canceled",
    description: "Nothing changed. Connect again when you are ready.",
  },
  expired: {
    title: "GitHub sign-in expired",
    description: "Start the connection again to sign in and return to this workspace.",
  },
  config: {
    title: "GitHub needs configuration",
    description: "Ask the instance operator to check the shared GitHub App.",
  },
  save: {
    title: "GitHub access could not be confirmed",
    description: "Derive could not verify and save this connection. Try connecting again.",
  },
}

/** Connection state and repository access belong here; skills and agent grants stay separate. */
export function GithubSection() {
  const qc = useQueryClient()
  const { data: workspace } = useQuery(workspaceQuery())
  const isAdmin = workspace?.role === "owner"
  const github = useQuery(githubQuery())
  const { github_connected, github_error } = useOneShotParams("github_connected", "github_error")
  const [result, setResult] = useState<{ connected: boolean; error?: string }>(() => ({
    connected: github_connected === "1",
    error: github_error,
  }))
  const [disconnecting, setDisconnecting] = useState<GithubIntegrationAccount | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const disconnect = useApiMutation({
    mutationFn: (id: string) => api.disconnectGithub(id),
    success: "GitHub disconnected",
    onSuccess: () => setResult({ connected: false }),
    invalidate: [githubQuery().queryKey, connectionsQuery().queryKey],
  })
  useEffect(() => {
    if (!result.connected && !result.error) return
    void qc.invalidateQueries({ queryKey: githubQuery().queryKey })
    void qc.invalidateQueries({ queryKey: connectionsQuery().queryKey })
  }, [result, qc])

  const data = github.data
  const verified =
    data?.accounts.some(
      (account) => account.state === "active" && account.permissions_state !== "unknown",
    ) && data.app_permissions_state !== "unknown"
  const message = result.error ? INSTALL_MESSAGES[result.error] : null
  return (
    <SettingsGroup
      title="GitHub"
      description="Connect your account and choose repositories on GitHub."
    >
      {result.error && (
        <StatusPanel
          layout="inline"
          tone={["requested", "canceled"].includes(result.error) ? "warning" : "danger"}
          title={message?.title ?? "GitHub could not be connected"}
          description={message?.description ?? "Start the connection again."}
        />
      )}
      {github.isPending ? (
        <SettingsListSkeleton />
      ) : github.isError ? (
        <LoadError
          layout="inline"
          title="Could not load GitHub access"
          testId="github-retry"
          onRetry={() => github.refetch()}
        />
      ) : data && !data.available ? (
        <ListRow
          title="GitHub is not configured"
          meta="An instance operator must configure the shared GitHub App."
          actions={
            data.can_manage_app ? (
              <Button variant="ghost" size="sm" data-testid="github-setup" asChild>
                <a href="/settings/github/app/new">Set up App</a>
              </Button>
            ) : undefined
          }
        />
      ) : data ? (
        <>
          {result.connected && (
            <StatusPanel
              layout="inline"
              tone={github.isFetching ? "neutral" : verified ? "success" : "warning"}
              title={
                github.isFetching
                  ? "Checking the GitHub connection…"
                  : verified
                    ? "GitHub connected"
                    : "GitHub access could not be confirmed"
              }
              description={
                github.isFetching
                  ? "Derive is checking your installation."
                  : verified
                    ? "Your account is connected. View its repositories below."
                    : "Refresh access or connect again."
              }
            />
          )}
          {data.app_permissions_state === "update_required" && (
            <StatusPanel
              layout="inline"
              tone="warning"
              title="GitHub App update required"
              description={`${data.app_owner_login ? `The App owner, @${data.app_owner_login},` : "The App owner"} must update its permissions. Existing supported access stays available.`}
              action={
                data.can_manage_app && data.app_settings_url ? (
                  <Button variant="outline" size="sm" data-testid="github-update-app" asChild>
                    <a href={data.app_settings_url}>Review App settings</a>
                  </Button>
                ) : undefined
              }
            />
          )}
          {data.accounts.map((account) => {
            const unknown =
              account.permissions_state === "unknown" || data.app_permissions_state === "unknown"
            const approval = account.permissions_state === "approval_required"
            const active = account.state === "active"
            return (
              <ListRow
                className="[&>div:first-child]:flex-wrap [&>div:first-child>div:last-child]:max-w-full"
                key={account.installation_id}
                title={
                  <span className="flex flex-wrap items-center gap-2">
                    {account.account_login ?? "GitHub account"}
                    <StatusBadge
                      tone={!active || approval ? "attention" : unknown ? "muted" : "ok"}
                    >
                      {!active
                        ? account.state === "needs_reauth"
                          ? "Reconnect needed"
                          : "Disconnected"
                        : approval
                          ? "Approval required"
                          : unknown
                            ? "Access not verified"
                            : "Connected"}
                    </StatusBadge>
                  </span>
                }
                meta={
                  !active
                    ? "Connect again to restore repository access."
                    : approval
                      ? "A GitHub account owner must approve updated permissions."
                      : unknown
                        ? "GitHub could not be checked. Refresh access to try again."
                        : "Available to this workspace. Assign this source to an agent when needed."
                }
                actions={
                  <>
                    {active && account.connection_id && (
                      <Button
                        variant="ghost"
                        size="sm"
                        data-testid={`github-repositories-${account.installation_id}`}
                        onClick={() =>
                          setExpanded(
                            expanded === account.connection_id ? null : account.connection_id,
                          )
                        }
                      >
                        {expanded === account.connection_id
                          ? "Hide repositories"
                          : "View repositories"}
                      </Button>
                    )}
                    {isAdmin && account.installation_url && (
                      <Button
                        variant="ghost"
                        size="sm"
                        data-testid={`github-manage-${account.installation_id}`}
                        asChild
                      >
                        <a href={account.installation_url}>Manage access on GitHub</a>
                      </Button>
                    )}
                    {isAdmin &&
                      (!active ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          data-testid={`github-reconnect-${account.installation_id}`}
                          asChild
                        >
                          <a href="/v1/github/install">Reconnect</a>
                        </Button>
                      ) : (
                        <Button
                          variant="destructive-ghost"
                          size="sm"
                          data-testid={`github-disconnect-${account.installation_id}`}
                          onClick={() => setDisconnecting(account)}
                        >
                          Disconnect
                        </Button>
                      ))}
                  </>
                }
                below={
                  expanded === account.connection_id && account.connection_id ? (
                    <Repositories connectionId={account.connection_id} />
                  ) : undefined
                }
              />
            )
          })}
          <ListRow
            title={data.accounts.length ? "Connect another account" : "Connect GitHub"}
            meta={<span>Use an existing installation or choose repositories on GitHub.</span>}
            actions={
              isAdmin ? (
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid={data.accounts.length ? "github-add-account" : "github-connect"}
                  asChild
                >
                  <a href="/v1/github/install">
                    {data.accounts.length ? "Connect account" : "Connect GitHub"}
                  </a>
                </Button>
              ) : undefined
            }
          />
          {data.accounts.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              data-testid="github-refresh"
              loading={github.isFetching}
              onClick={() => {
                setExpanded(null)
                void qc.invalidateQueries({ queryKey: githubQuery().queryKey })
              }}
            >
              Refresh access
            </Button>
          )}
          {!isAdmin && <AdminNote can="manage the GitHub connection" />}
        </>
      ) : null}
      <ConfirmDialog
        open={!!disconnecting}
        onOpenChange={(open) => !open && setDisconnecting(null)}
        title="Disconnect GitHub?"
        description="Agents lose access immediately. The App stays installed on GitHub, so you can reconnect."
        confirmLabel="Disconnect"
        confirmTestId="github-disconnect-confirm"
        onConfirm={() => {
          if (disconnecting?.connection_id) disconnect.mutate(disconnecting.connection_id)
          setDisconnecting(null)
        }}
      />
    </SettingsGroup>
  )
}

function Repositories({ connectionId }: { connectionId: string }) {
  const [page, setPage] = useState(1)
  const repos = useQuery(githubRepositoriesQuery(connectionId, page))
  if (repos.isPending) return <SettingsListSkeleton />
  if (repos.isError)
    return (
      <LoadError
        layout="inline"
        title={repos.error.message}
        testId="github-repositories-retry"
        onRetry={() => repos.refetch()}
      />
    )
  return (
    <div
      className="flex flex-col gap-3 rounded-lg bg-muted p-4"
      data-testid="github-repository-list"
    >
      <p className="text-sm font-medium">{repos.data.total_count} repositories available</p>
      {repos.data.repositories.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No repositories are selected. Manage access on GitHub to choose repositories.
        </p>
      ) : (
        repos.data.repositories.map((repo) => (
          <div key={repo.id} className="flex flex-wrap items-center gap-2 text-sm">
            <a href={repo.html_url} className="break-all underline underline-offset-4">
              {repo.full_name}
            </a>
            <StatusBadge tone="muted">{repo.private ? "Private" : "Public"}</StatusBadge>
          </div>
        ))
      )}
      {(page > 1 || repos.data.has_more) && (
        <div className="flex gap-2">
          <Button
            variant="ghost"
            size="sm"
            data-testid="github-repositories-previous"
            disabled={page === 1}
            onClick={() => setPage(page - 1)}
          >
            Previous
          </Button>
          <Button
            variant="ghost"
            size="sm"
            data-testid="github-repositories-next"
            disabled={!repos.data.has_more}
            onClick={() => setPage(page + 1)}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  )
}
