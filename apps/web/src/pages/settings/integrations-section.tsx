import { useQuery, useQueryClient } from "@tanstack/react-query"
import { AlertTriangle } from "lucide-react"
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
import { toast } from "@/components/ui/sonner"
import { connectionsQuery, githubQuery, slackQuery, workspaceQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import { useOneShotParams } from "@/lib/use-one-shot-params"
import { SettingsListSkeleton } from "./settings-list-skeleton"
import { SlackSubscriptionsSection } from "./slack-subscriptions-section"

type SlackInstallResult = { connected: true } | { connected: false; error: string } | null
type GithubInstallResult = { connected: true } | { connected: false; error: string } | null

const DEFAULT_SLACK_INSTALL_ERROR = {
  title: "Slack couldn't be connected",
  description: "Slack didn't complete the authorization. Try again or check the app configuration.",
}

const SLACK_INSTALL_ERRORS: Record<string, { title: string; description: string }> = {
  canceled: {
    title: "Slack connection canceled",
    description: "Nothing changed. When you're ready, start the connection again below.",
  },
  expired: {
    title: "Slack connection expired",
    description: "The authorization session was missing or expired. Start again below.",
  },
  config: {
    title: "Slack app configuration needs attention",
    description:
      "Slack rejected this app's credentials, redirect URL, or workspace eligibility. Check the Slack app configuration, then try again.",
  },
  save: {
    title: "Derive couldn't save the Slack connection",
    description: "Slack approved the app, but Derive couldn't persist the installation. Try again.",
  },
  oauth: DEFAULT_SLACK_INSTALL_ERROR,
}

const DEFAULT_GITHUB_INSTALL_ERROR = {
  title: "GitHub couldn't be connected",
  description: "GitHub didn't complete the installation. Try again or check the App configuration.",
}

const GITHUB_INSTALL_ERRORS: Record<string, { title: string; description: string }> = {
  canceled: {
    title: "GitHub connection canceled",
    description: "Nothing changed. Connect again when you're ready to select repositories.",
  },
  expired: {
    title: "GitHub connection expired",
    description: "The login session was missing or expired. Start the connection again.",
  },
  config: {
    title: "GitHub App configuration needs attention",
    description: "The App is missing or the installation response was invalid.",
  },
  save: {
    title: "Derive couldn't save the GitHub connection",
    description: "GitHub approved the App, but Derive couldn't persist the connection. Try again.",
  },
}

// The GitHub and Slack groups of Settings › Sources. GitHub's install callback creates the
// workspace connection directly, with no repo mirroring UI. Slack delivery destinations live
// in slack-subscriptions-section.tsx, drawn under the Slack group once it is connected.
export function IntegrationGroups() {
  const qc = useQueryClient()
  // The verbs PATCH admin-only endpoints; mirror that gate in the UI so a non-admin sees the
  // workspace's state without a button that 403s.
  const { data: ws } = useQuery(workspaceQuery())
  const isAdmin = ws?.role === "owner"
  const { data: slack, isFetching: slackIsFetching } = useQuery(slackQuery())
  const {
    data: github,
    isPending: githubIsPending,
    isFetching: githubIsFetching,
    isError: githubIsError,
    refetch: refetchGithub,
  } = useQuery(githubQuery())
  // The one-shot callback results the Slack OAuth and GitHub App flows land back on.
  const {
    slack_connected: slackConnected,
    slack_error: slackError,
    github_connected: githubConnected,
    github_error: githubError,
  } = useOneShotParams("slack_connected", "slack_error", "github_connected", "github_error")
  const [slackInstallResult] = useState<SlackInstallResult>(() =>
    slackConnected === "1"
      ? { connected: true }
      : slackError
        ? { connected: false, error: slackError }
        : null,
  )
  const [githubInstallResult] = useState<GithubInstallResult>(() =>
    githubConnected === "1"
      ? { connected: true }
      : githubError
        ? { connected: false, error: githubError }
        : null,
  )
  const slackInstallError =
    slackInstallResult && !slackInstallResult.connected
      ? (SLACK_INSTALL_ERRORS[slackInstallResult.error] ?? DEFAULT_SLACK_INSTALL_ERROR)
      : null
  const githubInstallError =
    githubInstallResult && !githubInstallResult.connected
      ? (GITHUB_INSTALL_ERRORS[githubInstallResult.error] ?? DEFAULT_GITHUB_INSTALL_ERROR)
      : null
  const [disconnectingSlack, setDisconnectingSlack] = useState(false)
  const [disconnectingGithub, setDisconnectingGithub] = useState<GithubIntegrationAccount | null>(
    null,
  )

  useEffect(() => {
    if (!slackInstallResult) return
    void qc.invalidateQueries({ queryKey: slackQuery().queryKey })
    if (slackInstallResult.connected) toast.success("Slack connected")
  }, [slackInstallResult, qc])

  useEffect(() => {
    if (!githubInstallResult) return
    void qc.invalidateQueries({ queryKey: githubQuery().queryKey })
    void qc.invalidateQueries({ queryKey: connectionsQuery().queryKey })
    if (githubInstallResult.connected) toast.success("GitHub connected")
  }, [githubInstallResult, qc])

  const disconnect = useApiMutation({
    mutationFn: () => api.disconnectSlack(),
    success: "Slack disconnected",
    invalidate: [slackQuery().queryKey],
  })
  const disconnectSlack = () => disconnect.mutate()

  const disconnectGithub = useApiMutation({
    mutationFn: (connectionId: string) => api.disconnectGithub(connectionId),
    success: "GitHub disconnected",
    invalidate: [githubQuery().queryKey, connectionsQuery().queryKey],
  })
  const confirmDisconnectGithub = () => {
    const connectionId = disconnectingGithub?.connection_id
    if (!connectionId) return
    setDisconnectingGithub(null)
    disconnectGithub.mutate(connectionId)
  }

  return (
    <>
      <SettingsGroup
        title="GitHub"
        description="Pull requests, PR comments, and selected GitHub Actions workflows. Derive does not mirror repository files."
      >
        {githubInstallError && githubInstallResult && !githubInstallResult.connected && (
          <StatusPanel
            tone={githubInstallResult.error === "canceled" ? "warning" : "danger"}
            layout="inline"
            icon={<AlertTriangle aria-hidden />}
            title={githubInstallError.title}
            description={githubInstallError.description}
            action={
              isAdmin && (
                <Button data-testid="github-install-retry" variant="outline" size="sm" asChild>
                  <a href="/v1/github/install">Try again</a>
                </Button>
              )
            }
          />
        )}
        {githubIsPending ? (
          <SettingsListSkeleton />
        ) : githubIsError ? (
          <LoadError
            layout="inline"
            title="Couldn’t load the GitHub connection"
            testId="github-retry"
            onRetry={() => refetchGithub()}
          />
        ) : github && !github.available ? (
          <ListRow
            title={
              <span className="flex flex-wrap items-center gap-2">
                GitHub App
                <StatusBadge tone="muted">Not configured</StatusBadge>
              </span>
            }
            meta={
              github.can_manage_app
                ? "Create the shared App once for this Derive instance."
                : "Ask an instance operator to configure the shared GitHub App."
            }
            actions={
              github.can_manage_app ? (
                <Button data-testid="github-setup" variant="ghost" size="sm" asChild>
                  <a href="/settings/github/app/new">Set up App</a>
                </Button>
              ) : undefined
            }
          />
        ) : githubInstallResult?.connected && !github?.connected ? (
          <StatusPanel
            tone={githubIsFetching ? "neutral" : "danger"}
            layout="inline"
            title={
              githubIsFetching
                ? "Finishing the GitHub connection…"
                : "GitHub approved the App, but the connection is missing"
            }
            description={
              githubIsFetching
                ? "Derive is confirming the installation and workspace connection now."
                : "Derive couldn't confirm the saved connection. Connect once more."
            }
            action={
              !githubIsFetching &&
              isAdmin && (
                <Button data-testid="github-confirm-retry" variant="outline" size="sm" asChild>
                  <a href="/v1/github/install">Try again</a>
                </Button>
              )
            }
          />
        ) : github ? (
          <>
            <ListRow
              title={
                <span className="flex flex-wrap items-center gap-2">
                  GitHub App
                  {github.app_permissions_state === "update_required" ? (
                    <StatusBadge tone="attention">Update required</StatusBadge>
                  ) : github.app_permissions_state === "ready" ? (
                    <StatusBadge tone="ok">Ready</StatusBadge>
                  ) : (
                    <StatusBadge tone="muted">Status unknown</StatusBadge>
                  )}
                </span>
              }
              meta={
                github.app_permissions_state === "update_required"
                  ? `${github.app_owner_login ? `@${github.app_owner_login} owns this App. ` : ""}An App owner or manager must grant Contents, Pull requests and Actions read and write. Workflow repository tokens are limited to the selected repositories and access level.`
                  : github.app_permissions_state === "ready"
                    ? `${github.app_owner_login ? `Owned by @${github.app_owner_login}. ` : ""}The App permissions are current.`
                    : "Derive could not confirm the App settings. Existing connections remain available."
              }
              actions={
                github.app_permissions_state === "update_required" &&
                github.can_manage_app &&
                github.app_settings_url ? (
                  <Button data-testid="github-update-app" variant="ghost" size="sm" asChild>
                    <a href={github.app_settings_url}>Review App settings</a>
                  </Button>
                ) : undefined
              }
            />
            {github.accounts.map((account) => (
              <ListRow
                key={account.installation_id}
                title={
                  <span className="flex flex-wrap items-center gap-2">
                    {account.account_login ?? `Installation ${account.installation_id}`}
                    {account.state === "needs_reauth" ? (
                      <StatusBadge tone="attention">Needs reconnect</StatusBadge>
                    ) : github.app_permissions_state === "ready" &&
                      account.permissions_state === "approval_required" ? (
                      <StatusBadge tone="attention">Approval required</StatusBadge>
                    ) : account.state === "active" ? (
                      <StatusBadge tone="ok">Connected</StatusBadge>
                    ) : (
                      <StatusBadge tone="muted">Disconnected</StatusBadge>
                    )}
                  </span>
                }
                meta={
                  account.state === "needs_reauth"
                    ? "The GitHub installation is missing or was removed."
                    : github.app_permissions_state === "ready" &&
                        account.permissions_state === "approval_required"
                      ? "A GitHub account owner must approve the App's updated permissions."
                      : account.state === "active"
                        ? "Available to this workspace's agents."
                        : "Installed, but disconnected from agent use."
                }
                actions={
                  isAdmin ? (
                    <>
                      {github.app_permissions_state === "ready" &&
                        account.permissions_state === "approval_required" &&
                        account.permissions_url && (
                          <Button
                            data-testid={`github-approve-${account.installation_id}`}
                            variant="ghost"
                            size="sm"
                            asChild
                          >
                            <a href={account.permissions_url}>Review update</a>
                          </Button>
                        )}
                      {account.state === "active" && account.connection_id ? (
                        <Button
                          data-testid={`github-disconnect-${account.installation_id}`}
                          variant="destructive-ghost"
                          size="sm"
                          onClick={() => setDisconnectingGithub(account)}
                        >
                          Disconnect
                        </Button>
                      ) : (
                        <Button
                          data-testid={`github-reconnect-${account.installation_id}`}
                          variant="ghost"
                          size="sm"
                          asChild
                        >
                          <a href="/v1/github/install">Reconnect</a>
                        </Button>
                      )}
                    </>
                  ) : undefined
                }
              />
            ))}
            {github.app_permissions_state !== "update_required" && (
              <ListRow
                title={github.accounts.length ? "Another GitHub account" : "GitHub account"}
                meta="Connect an existing App installation or install it on another GitHub account."
                actions={
                  isAdmin ? (
                    <Button
                      data-testid={github.accounts.length ? "github-add-account" : "github-connect"}
                      variant="ghost"
                      size="sm"
                      asChild
                    >
                      <a href="/v1/github/install">
                        {github.accounts.length ? "Connect account" : "Connect"}
                      </a>
                    </Button>
                  ) : undefined
                }
              />
            )}
            {!isAdmin && <AdminNote can="manage the GitHub connection" />}
          </>
        ) : null}
        <ConfirmDialog
          open={!!disconnectingGithub}
          onOpenChange={(open) => !open && setDisconnectingGithub(null)}
          title="Disconnect GitHub?"
          description="Agents will immediately lose access to this GitHub installation. The App stays installed on GitHub, so reconnecting can restore existing bindings."
          confirmLabel="Disconnect"
          onConfirm={confirmDisconnectGithub}
          confirmTestId="github-disconnect-confirm"
        />
      </SettingsGroup>

      <SettingsGroup
        title="Slack"
        description={
          slack?.connected ? (
            <>
              Connected to{" "}
              <span className="font-medium">{slack.team_name ?? "your Slack workspace"}</span>.
              Choose which channels hear about what under <strong>Slack channels</strong> below, or
              run <code>/derive subscribe</code> in the channel itself.
            </>
          ) : undefined
        }
      >
        {slackInstallError && slackInstallResult && !slackInstallResult.connected && (
          <StatusPanel
            tone={slackInstallResult.error === "canceled" ? "warning" : "danger"}
            layout="inline"
            icon={<AlertTriangle aria-hidden />}
            title={slackInstallError.title}
            description={slackInstallError.description}
            action={
              <Button data-testid="slack-install-retry" variant="outline" size="sm" asChild>
                <a href="/v1/slack/install">Try again</a>
              </Button>
            }
          />
        )}
        {slack && !slack.available ? (
          <div className="flex flex-col items-start gap-3 py-1">
            <p className="text-sm text-muted-foreground">
              Slack isn't configured on this Derive instance yet. Create the app from a manifest
              (event subscriptions come pre-wired), add the three secrets, then connect.
            </p>
            <Button data-testid="slack-setup" variant="outline" size="sm" asChild>
              <a href="/settings/slack/app/new">Set up Slack app</a>
            </Button>
          </div>
        ) : slackInstallResult?.connected && !slack?.connected ? (
          <StatusPanel
            tone={slackIsFetching ? "neutral" : "danger"}
            layout="inline"
            title={
              slackIsFetching
                ? "Finishing the Slack connection…"
                : "Slack approved the app, but the connection is missing"
            }
            description={
              slackIsFetching
                ? "Slack approved the app. Derive is confirming the saved workspace now."
                : "Derive couldn't confirm the saved installation. Try connecting once more."
            }
            action={
              !slackIsFetching && (
                <Button data-testid="slack-confirm-retry" variant="outline" size="sm" asChild>
                  <a href="/v1/slack/install">Try again</a>
                </Button>
              )
            }
          />
        ) : slack?.connected ? (
          <>
            {slack.needs_reauth && (
              <div data-testid="slack-reauth-banner">
                <StatusPanel
                  tone="danger"
                  layout="inline"
                  title="Derive can't use the saved Slack connection"
                  description="The app may have been removed or its token revoked, or it needs a permission that was added since. Reconnect to fix it."
                  action={
                    <Button data-testid="slack-reconnect" variant="outline" size="sm" asChild>
                      <a href="/v1/slack/install">Reconnect Slack</a>
                    </Button>
                  }
                />
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2 py-3.5">
              <Button data-testid="slack-change-workspace" variant="outline" size="sm" asChild>
                <a href="/v1/slack/install">Change Slack workspace</a>
              </Button>
              <Button
                data-testid="slack-disconnect"
                variant="destructive-ghost"
                size="sm"
                onClick={() => setDisconnectingSlack(true)}
              >
                Disconnect Slack
              </Button>
            </div>
            <ConfirmDialog
              open={disconnectingSlack}
              onOpenChange={setDisconnectingSlack}
              title="Disconnect Slack?"
              description="Comments will stop posting to your channel, and replies from Slack will stop. You can reconnect anytime."
              confirmLabel="Disconnect"
              onConfirm={disconnectSlack}
              confirmTestId="slack-disconnect-confirm"
            />
          </>
        ) : (
          <div className="flex flex-col items-start gap-3 py-1">
            <p className="text-sm text-muted-foreground">
              Authorize a Slack workspace for this Derive workspace. If you already installed the
              app in Slack, complete this step once so Derive can save the connection.
            </p>
            <Button data-testid="slack-connect" variant="outline" size="sm" asChild>
              <a href="/v1/slack/install">Connect Slack</a>
            </Button>
          </div>
        )}
      </SettingsGroup>

      {/* Where Derive posts, per channel. Only meaningful once a workspace is connected. */}
      {slack?.connected ? <SlackSubscriptionsSection /> : null}
    </>
  )
}
