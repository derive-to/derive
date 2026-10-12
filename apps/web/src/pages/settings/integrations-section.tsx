import { useQuery, useQueryClient } from "@tanstack/react-query"
import { AlertTriangle } from "lucide-react"
import { useEffect, useState } from "react"
import { api } from "@/api"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { LoadError } from "@/components/shared/load-error"
import { SettingsGroup } from "@/components/shared/settings-group"
import { StatusPanel } from "@/components/shared/status-panel"
import { Button } from "@/components/ui/button"
import { toast } from "@/components/ui/sonner"
import { slackQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import { useOneShotParams } from "@/lib/use-one-shot-params"
import { GithubSection } from "./github-section"
import { SlackSubscriptionsSection } from "./slack-subscriptions-section"

type SlackInstallResult = { connected: true } | { connected: false; error: string } | null

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

// The GitHub and Slack groups of Settings › Sources. GitHub's install callback creates the
// workspace connection directly, with no repo mirroring UI. Slack delivery destinations live
// in slack-subscriptions-section.tsx, drawn under the Slack group once it is connected.
export function IntegrationGroups() {
  const qc = useQueryClient()
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

  return (
    <>
      <GithubSection />

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
        {slackIsError ? (
          <LoadError
            layout="inline"
            title="Could not load Slack access"
            testId="slack-retry"
            onRetry={() => refetchSlack()}
          />
        ) : slack && !slack.available ? (
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
