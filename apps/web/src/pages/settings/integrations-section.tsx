import { useQuery, useQueryClient } from "@tanstack/react-query"
import { AlertTriangle } from "lucide-react"
import { useEffect, useState } from "react"
import { api, type OrgSettings } from "@/api"
import { AdminNote } from "@/components/shared/admin-note"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { LoadError } from "@/components/shared/load-error"
import { SettingRow } from "@/components/shared/setting-row"
import { SettingsGroup } from "@/components/shared/settings-group"
import { StatusPanel } from "@/components/shared/status-panel"
import { Button } from "@/components/ui/button"
import { toast } from "@/components/ui/sonner"
import { Switch } from "@/components/ui/switch"
import { slackQuery, workspaceQuery, workspaceSettingsQuery } from "@/lib/queries"
import { snapshot, useApiMutation } from "@/lib/use-api-mutation"
import { useOneShotParams } from "@/lib/use-one-shot-params"
import { SettingsListSkeleton } from "./settings-list-skeleton"
import { SettingsSection } from "./settings-section"
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

// The workspace activity toggles (email + GitHub mirroring) plus the Slack connection —
// all workspace-wide. Personal notification prefs (your Slack DM, account link, auto-open)
// live in notifications-section.tsx. Where Slack posts is per-channel now — see
// slack-subscriptions-section.tsx. Toggles apply optimistically with no save (the toggle
// contract); the Slack channel id is an explicit save.
export function IntegrationsSection() {
  const qc = useQueryClient()
  const { data: settings, isPending, isError, refetch } = useQuery(workspaceSettingsQuery())
  // The toggles PATCH an admin-only endpoint; mirror that gate in the UI so a
  // non-admin sees the workspace's state without a switch that 403s on flip.
  const { data: ws } = useQuery(workspaceQuery())
  const isAdmin = ws?.role === "owner"
  const { data: slack, isFetching: slackIsFetching } = useQuery(slackQuery())
  // The one-shot callback result the Slack OAuth flow lands back on.
  const { slack_connected: slackConnected, slack_error: slackError } = useOneShotParams(
    "slack_connected",
    "slack_error",
  )
  const [installResult] = useState<SlackInstallResult>(() =>
    slackConnected === "1"
      ? { connected: true }
      : slackError
        ? { connected: false, error: slackError }
        : null,
  )
  const installError =
    installResult && !installResult.connected
      ? (SLACK_INSTALL_ERRORS[installResult.error] ?? DEFAULT_SLACK_INSTALL_ERROR)
      : null
  const [disconnecting, setDisconnecting] = useState(false)

  useEffect(() => {
    if (!installResult) return
    void qc.invalidateQueries({ queryKey: slackQuery().queryKey })
    if (installResult.connected) toast.success("Slack connected")
  }, [installResult, qc])

  // Toggle a single settings key, optimistically flipping the shared cache entry so the
  // switch stays live; the primitive rolls back + toasts on failure, and the server's
  // echoed settings replace the optimistic value on success.
  const update = useApiMutation({
    mutationFn: (patch: Partial<OrgSettings>) => api.updateWorkspaceSettings(patch),
    optimistic: (patch, client) => {
      const qk = workspaceSettingsQuery().queryKey
      const rollback = snapshot(client, qk)
      client.setQueryData(qk, (prev) => (prev ? { ...prev, ...patch } : prev))
      return rollback
    },
    onSuccess: (s) => qc.setQueryData(workspaceSettingsQuery().queryKey, s),
  })
  const flip = (key: keyof OrgSettings) => (next: boolean) =>
    update.mutate({ [key]: next } as Partial<OrgSettings>)

  const disconnect = useApiMutation({
    mutationFn: () => api.disconnectSlack(),
    success: "Slack disconnected",
    invalidate: [slackQuery().queryKey, workspaceSettingsQuery().queryKey],
  })
  const disconnectSlack = () => disconnect.mutate()

  return (
    <SettingsSection
      title="Integrations"
      description="Route this workspace's comment and PR activity to the tools your team already uses. Each switch applies instantly, for everyone."
    >
      {isPending ? (
        <SettingsListSkeleton />
      ) : isError ? (
        <LoadError
          title="Couldn’t load integration settings"
          testId="integrations-retry"
          onRetry={() => refetch()}
        />
      ) : settings ? (
        <>
          <SettingsGroup>
            <SettingRow
              htmlFor="toggle-email"
              label="Email notifications"
              description="Email collaborators when a comment mentions them or lands on a thread they're in. Switches activity email on or off for everyone in this workspace."
            >
              <Switch
                id="toggle-email"
                data-testid="toggle-email"
                checked={settings.emailNotifications}
                disabled={!isAdmin}
                onCheckedChange={flip("emailNotifications")}
              />
            </SettingRow>
            <SettingRow
              htmlFor="toggle-github-post"
              label="Post comments to GitHub"
              description="When you comment on a PR-sourced doc, mirror it onto the pull request."
            >
              <Switch
                id="toggle-github-post"
                data-testid="toggle-github-post"
                checked={settings.githubPostComments}
                disabled={!isAdmin}
                onCheckedChange={flip("githubPostComments")}
              />
            </SettingRow>
            <SettingRow
              htmlFor="toggle-github-mirror"
              label="Mirror PR comments into Derive"
              description="Comments made on the pull request show up on the Derive artifact."
            >
              <Switch
                id="toggle-github-mirror"
                data-testid="toggle-github-mirror"
                checked={settings.githubMirrorComments}
                disabled={!isAdmin}
                onCheckedChange={flip("githubMirrorComments")}
              />
            </SettingRow>
            <SettingRow
              htmlFor="toggle-github-preview-link"
              label="Comment a preview link on PRs"
              description="When a pull request opens, post (and keep updated) a comment linking to the Derive preview of its docs."
            >
              <Switch
                id="toggle-github-preview-link"
                data-testid="toggle-github-preview-link"
                checked={settings.githubPreviewLink}
                disabled={!isAdmin}
                onCheckedChange={flip("githubPreviewLink")}
              />
            </SettingRow>
          </SettingsGroup>
          {!isAdmin && <AdminNote can="change workspace activity settings" />}
        </>
      ) : null}

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
        {installError && installResult && !installResult.connected && (
          <StatusPanel
            tone={installResult.error === "canceled" ? "warning" : "danger"}
            layout="inline"
            icon={<AlertTriangle aria-hidden />}
            title={installError.title}
            description={installError.description}
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
            <Button data-testid="slack-setup" variant="default" asChild>
              <a href="/settings/slack/app/new">Set up Slack app</a>
            </Button>
          </div>
        ) : installResult?.connected && !slack?.connected ? (
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
                    <Button data-testid="slack-reconnect" variant="default" size="sm" asChild>
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
                onClick={() => setDisconnecting(true)}
              >
                Disconnect Slack
              </Button>
            </div>
            <ConfirmDialog
              open={disconnecting}
              onOpenChange={setDisconnecting}
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
            <Button data-testid="slack-connect" variant="default" asChild>
              <a href="/v1/slack/install">Connect Slack</a>
            </Button>
          </div>
        )}
      </SettingsGroup>

      {/* Where Derive posts, per channel. Only meaningful once a workspace is connected. */}
      {slack?.connected ? <SlackSubscriptionsSection /> : null}
    </SettingsSection>
  )
}
