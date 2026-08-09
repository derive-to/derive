import { useQuery, useQueryClient } from "@tanstack/react-query"
import { AlertTriangle } from "lucide-react"
import { useEffect, useState } from "react"
import { api, type OrgSettings } from "@/api"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { LoadError } from "@/components/shared/load-error"
import { SettingRow } from "@/components/shared/setting-row"
import { SettingsGroup } from "@/components/shared/settings-group"
import { StatusPanel } from "@/components/shared/status-panel"
import { Button } from "@/components/ui/button"
import { toast } from "@/components/ui/sonner"
import { Switch } from "@/components/ui/switch"
import { slackQuery, workspaceSettingsQuery } from "@/lib/queries"
import { snapshot, useApiMutation } from "@/lib/use-api-mutation"
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

// Read the one-shot callback result without mutating browser state during render.
// The effect below clears it after mount and invalidates any restored Slack cache.
const readSlackInstallResult = (): SlackInstallResult => {
  if (typeof window === "undefined") return null
  const qs = new URLSearchParams(window.location.search)
  const connected = qs.get("slack_connected") === "1"
  const error = qs.get("slack_error")
  if (!connected && !error) return null
  return connected ? { connected: true } : { connected: false, error: error ?? "oauth" }
}

// The workspace activity toggles (email + GitHub mirroring) plus the Slack connection.
// Where Slack posts is per-channel now — see slack-subscriptions-section.tsx. Toggles apply optimistically
// with no save (the toggle contract); the Slack channel id is an explicit save.
export function IntegrationsSection() {
  const qc = useQueryClient()
  const { data: settings, isPending, isError, refetch } = useQuery(workspaceSettingsQuery())
  const { data: slack, isFetching: slackIsFetching } = useQuery(slackQuery())
  const [installResult] = useState(readSlackInstallResult)
  const installError =
    installResult && !installResult.connected
      ? (SLACK_INSTALL_ERRORS[installResult.error] ?? DEFAULT_SLACK_INSTALL_ERROR)
      : null
  const [disconnecting, setDisconnecting] = useState(false)

  useEffect(() => {
    if (!installResult) return
    const cleanupUrl = window.setTimeout(() => {
      const qs = new URLSearchParams(window.location.search)
      qs.delete("slack_connected")
      qs.delete("slack_error")
      const rest = qs.toString()
      window.history.replaceState(
        window.history.state,
        "",
        `${window.location.pathname}${rest ? `?${rest}` : ""}`,
      )
    }, 0)
    void qc.invalidateQueries({ queryKey: slackQuery().queryKey })
    if (installResult.connected) toast.success("Slack connected")
    return () => window.clearTimeout(cleanupUrl)
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
  // Optimistically flip the caller's Slack-DM preference in the slack cache.
  const slackDm = useApiMutation({
    mutationFn: (next: boolean) => api.setSlackDm(next),
    optimistic: (next, client) => {
      const qk = slackQuery().queryKey
      const rollback = snapshot(client, qk)
      client.setQueryData(qk, (prev) => (prev ? { ...prev, slack_dm: next } : prev))
      return rollback
    },
  })
  const toggleSlackDm = (next: boolean) => slackDm.mutate(next)
  const testDm = useApiMutation({
    mutationFn: () => api.sendSlackTestDm(),
    success: "Test DM sent",
  })
  const sendTestDm = () => testDm.mutate()
  const unlink = useApiMutation({
    mutationFn: () => api.unlinkSlack(),
    success: "Slack account unlinked",
    invalidate: [slackQuery().queryKey],
  })
  const unlinkSlack = () => unlink.mutate()

  return (
    <SettingsSection
      title="Integrations"
      description="Route comment and PR activity to the tools your team already uses. Each switch applies instantly."
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
        <SettingsGroup>
          <SettingRow
            htmlFor="toggle-email"
            label="Email notifications"
            description="Email collaborators when a comment mentions them or lands on a thread they're in."
          >
            <Switch
              id="toggle-email"
              data-testid="toggle-email"
              checked={settings.emailNotifications}
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
              onCheckedChange={flip("githubPreviewLink")}
            />
          </SettingRow>
        </SettingsGroup>
      ) : null}

      <SettingsGroup title="Slack">
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
          <div className="flex flex-col gap-4 py-1">
            <p className="text-sm">
              Connected to{" "}
              <span className="font-medium">{slack.team_name ?? "your Slack workspace"}</span>.
            </p>
            {slack.needs_reauth && (
              <div
                data-testid="slack-reauth-banner"
                className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
              >
                Derive can't use the saved Slack connection (the app may have been removed or its
                token revoked, or it needs a permission that was added since. Reconnect to fix it.
                <div className="mt-2">
                  <Button data-testid="slack-reconnect" variant="default" size="sm" asChild>
                    <a href="/v1/slack/install">Reconnect Slack</a>
                  </Button>
                </div>
              </div>
            )}
            <SettingRow
              htmlFor="toggle-slack-dm"
              label="DM me for interrupts"
              description="A Slack direct message when someone @mentions you, requests your review, or shares a doc with you — the same events that email you. Link your Slack account below for reliable delivery; otherwise Derive matches you by account email."
            >
              <div className="flex items-center gap-2">
                <Button
                  data-testid="slack-test-dm"
                  variant="outline"
                  size="sm"
                  onClick={sendTestDm}
                  loading={testDm.isPending}
                >
                  Send test DM
                </Button>
                <Switch
                  id="toggle-slack-dm"
                  data-testid="toggle-slack-dm"
                  checked={slack.slack_dm}
                  onCheckedChange={toggleSlackDm}
                />
              </div>
            </SettingRow>
            <SettingRow
              label="Your Slack account"
              description={
                slack.linked
                  ? "Linked. DMs and thread attribution resolve to your Slack identity directly."
                  : "Link your Slack account so DMs reach you even if your Slack email differs, and Slack replies are attributed to you."
              }
            >
              {slack.linked ? (
                <Button
                  data-testid="slack-unlink"
                  variant="outline"
                  size="sm"
                  onClick={unlinkSlack}
                  loading={unlink.isPending}
                >
                  Unlink
                </Button>
              ) : (
                <Button data-testid="slack-link" variant="default" size="sm" asChild>
                  <a href="/v1/slack/link">Link account</a>
                </Button>
              )}
            </SettingRow>
            <p className="text-sm text-muted-foreground">
              Choose which channels hear about what under <strong>Slack channels</strong> below, or
              run <code>/derive subscribe</code> in the channel itself.
            </p>
            <div>
              <div className="flex flex-wrap items-center gap-2">
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
          </div>
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
