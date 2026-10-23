import { useQuery, useQueryClient } from "@tanstack/react-query"
import { AlertTriangle } from "lucide-react"
import { useEffect, useState } from "react"
import { api } from "@/api"
import { AccountMark } from "@/components/shared/account-mark"
import { AdminNote } from "@/components/shared/admin-note"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { ConnectPrompt } from "@/components/shared/connect-prompt"
import { ListRow } from "@/components/shared/list-row"
import { LoadError } from "@/components/shared/load-error"
import { SettingsGroup } from "@/components/shared/settings-group"
import { StatusBadge } from "@/components/shared/status-badge"
import { StatusPanel } from "@/components/shared/status-panel"
import { Button } from "@/components/ui/button"
import { toast } from "@/components/ui/sonner"
import { slackQuery, workspaceQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import { useOneShotParams } from "@/lib/use-one-shot-params"
import { GithubSection } from "./github-section"
import { SettingsListSkeleton } from "./settings-list-skeleton"
import { SlackSubscriptionsSection } from "./slack-subscriptions-section"

type SlackInstallResult = { connected: true } | { connected: false; error: string } | null

const DEFAULT_SLACK_INSTALL_ERROR = {
  title: "Slack couldn't be connected",
  description: "Slack didn't finish the sign-in. Try again.",
}

const SLACK_INSTALL_ERRORS: Record<string, { title: string; description: string }> = {
  canceled: {
    title: "Slack connection canceled",
    description: "Nothing changed.",
  },
  expired: {
    title: "The Slack sign-in expired",
    description: "Start again to sign in and come back to this workspace.",
  },
  config: {
    title: "The Slack app isn't set up correctly",
    description:
      "Slack rejected the app's credentials, its redirect address, or this Slack workspace. Check the app's setup, then try again.",
  },
  save: {
    title: "Derive couldn't save the Slack connection",
    description: "Slack approved the app, but Derive couldn't save it. Try again.",
  },
  oauth: DEFAULT_SLACK_INSTALL_ERROR,
}

// The GitHub and Slack groups of Settings › Sources. GitHub's install callback creates the
// workspace connection directly, with no repo mirroring UI. Slack delivery destinations live
// in slack-subscriptions-section.tsx, drawn under the Slack group once it is connected.
const SLACK_INSTALL_URL = "/v1/slack/install"

export function IntegrationGroups() {
  const qc = useQueryClient()
  const { data: workspace } = useQuery(workspaceQuery())
  const isAdmin = workspace?.role === "owner"
  const {
    data: slack,
    isFetching: slackIsFetching,
    isError: slackIsError,
    refetch: refetchSlack,
  } = useQuery(slackQuery())
  // The one-shot callback results the Slack OAuth and GitHub App flows land back on.
  const { slack_connected: slackConnected, slack_error: slackError } = useOneShotParams(
    "slack_connected",
    "slack_error",
  )
  const [slackInstallResult] = useState<SlackInstallResult>(() =>
    slackConnected === "1"
      ? { connected: true }
      : slackError
        ? { connected: false, error: slackError }
        : null,
  )
  const slackInstallError =
    slackInstallResult && !slackInstallResult.connected
      ? (SLACK_INSTALL_ERRORS[slackInstallResult.error] ?? DEFAULT_SLACK_INSTALL_ERROR)
      : null
  const [disconnectingSlack, setDisconnectingSlack] = useState(false)
  useEffect(() => {
    if (!slackInstallResult) return
    void qc.invalidateQueries({ queryKey: slackQuery().queryKey })
    if (slackInstallResult.connected) toast.success("Slack connected")
  }, [slackInstallResult, qc])

  const disconnect = useApiMutation({
    mutationFn: () => api.disconnectSlack(),
    success: "Slack disconnected",
    invalidate: [slackQuery().queryKey],
  })
  const disconnectSlack = () => disconnect.mutate()

  const connected = !!slack?.connected
  const team = slack?.team_name ?? "Slack workspace"

  return (
    <>
      <GithubSection />

      <SettingsGroup
        title="Slack"
        description="Derive posts to the channels you choose, and replies there come back as comments."
      >
        {slackInstallError && slackInstallResult && !slackInstallResult.connected && (
          <StatusPanel
            tone={slackInstallResult.error === "canceled" ? "warning" : "danger"}
            layout="inline"
            icon={<AlertTriangle aria-hidden />}
            title={slackInstallError.title}
            description={slackInstallError.description}
            action={
              isAdmin ? (
                <Button data-testid="slack-install-retry" variant="outline" size="sm" asChild>
                  <a href={SLACK_INSTALL_URL}>Try again</a>
                </Button>
              ) : undefined
            }
          />
        )}
        {slackIsError ? (
          <LoadError
            layout="inline"
            title="Couldn't load Slack"
            testId="slack-retry"
            onRetry={() => refetchSlack()}
          />
        ) : !slack ? (
          <SettingsListSkeleton rows={1} />
        ) : !slack.available ? (
          <ConnectPrompt
            action={
              <Button data-testid="slack-setup" variant="outline" size="sm" asChild>
                <a href="/settings/slack/app/new">Set up Slack app</a>
              </Button>
            }
          >
            Slack isn't set up on this Derive instance yet. Create the app from a manifest, add its
            three secrets, then connect.
          </ConnectPrompt>
        ) : slackInstallResult?.connected && !connected ? (
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
                ? "Derive is confirming the saved workspace."
                : "Derive couldn't confirm the saved installation. Try connecting once more."
            }
            action={
              !slackIsFetching && (
                <Button data-testid="slack-confirm-retry" variant="outline" size="sm" asChild>
                  <a href={SLACK_INSTALL_URL}>Try again</a>
                </Button>
              )
            }
          />
        ) : connected ? (
          <ListRow
            data-testid="slack-workspace"
            leading={<AccountMark name={team} />}
            title={
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate">{team}</span>
                {slack.needs_reauth && (
                  <StatusBadge tone="attention" data-testid="slack-reauth-banner">
                    Reconnect needed
                  </StatusBadge>
                )}
              </span>
            }
            meta={
              slack.needs_reauth
                ? "Derive can't use this connection. Reconnect to fix it."
                : "Slack workspace"
            }
            stackActions
            actions={
              isAdmin ? (
                <>
                  {slack.needs_reauth ? (
                    <Button data-testid="slack-reconnect" variant="ghost" size="sm" asChild>
                      <a href={SLACK_INSTALL_URL}>Reconnect</a>
                    </Button>
                  ) : (
                    <Button data-testid="slack-change-workspace" variant="ghost" size="sm" asChild>
                      <a href={SLACK_INSTALL_URL}>Change workspace</a>
                    </Button>
                  )}
                  <Button
                    data-testid="slack-disconnect"
                    variant="destructive-ghost"
                    size="sm"
                    onClick={() => setDisconnectingSlack(true)}
                  >
                    Disconnect
                  </Button>
                </>
              ) : undefined
            }
          />
        ) : (
          <ConnectPrompt
            action={
              isAdmin ? (
                <Button data-testid="slack-connect" variant="outline" size="sm" asChild>
                  <a href={SLACK_INSTALL_URL}>Connect Slack</a>
                </Button>
              ) : undefined
            }
          >
            Connect a Slack workspace so Derive can post to its channels. If the app is already
            installed in Slack, connect once here so Derive can save it.
          </ConnectPrompt>
        )}
        {slack?.available && !isAdmin && <AdminNote can="connect Slack" />}
        <ConfirmDialog
          open={disconnectingSlack}
          onOpenChange={setDisconnectingSlack}
          title={`Disconnect ${team}?`}
          description="Derive stops posting to its channels, and replies there stop coming back. You can connect it again later."
          confirmLabel="Disconnect"
          onConfirm={disconnectSlack}
          confirmTestId="slack-disconnect-confirm"
        />
      </SettingsGroup>

      {/* Where Derive posts, per channel. Only meaningful once a workspace is connected. */}
      {connected ? <SlackSubscriptionsSection /> : null}
    </>
  )
}
