import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { api, type OrgSettings } from "@/api"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { FormField } from "@/components/shared/form-field"
import { SettingRow } from "@/components/shared/setting-row"
import { SettingsGroup } from "@/components/shared/settings-group"
import { StatusPanel } from "@/components/shared/status-panel"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { slackQuery, workspaceSettingsQuery } from "@/lib/queries"
import { snapshot, useApiMutation } from "@/lib/use-api-mutation"
import { SettingsListSkeleton } from "./settings-list-skeleton"
import { SettingsSection } from "./settings-section"

// The five workspace activity channels (email + GitHub mirroring + Slack posting)
// as instant toggles, plus the Slack connection. Toggles apply optimistically
// with no save (the toggle contract); the Slack channel id is an explicit save.
export function IntegrationsSection() {
  const qc = useQueryClient()
  const { data: settings, isPending, isError, refetch } = useQuery(workspaceSettingsQuery())
  const { data: slack } = useQuery(slackQuery())
  const [channel, setChannel] = useState("")
  const [disconnecting, setDisconnecting] = useState(false)

  // Seed the editable channel id from the Slack status once it loads.
  useEffect(() => {
    if (slack) setChannel(slack.default_channel ?? "")
  }, [slack])

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

  const saveCh = useApiMutation({
    mutationFn: () => api.setSlackChannel(channel.trim() || null),
    success: "Slack channel saved",
  })
  const saveChannel = () => saveCh.mutate()
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
        <StatusPanel
          tone="danger"
          title="Couldn't load integration settings"
          description="This is usually temporary."
          action={
            <Button
              variant="outline"
              size="sm"
              data-testid="integrations-retry"
              onClick={() => refetch()}
            >
              Try again
            </Button>
          }
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
          <SettingRow
            htmlFor="toggle-slack-post"
            label="Post activity to Slack"
            description="Send comments to the connected Slack channel; replies there post back to Derive."
          >
            <Switch
              id="toggle-slack-post"
              data-testid="toggle-slack-post"
              checked={settings.slackPost}
              onCheckedChange={flip("slackPost")}
            />
          </SettingRow>
        </SettingsGroup>
      ) : null}

      <SettingsGroup title="Slack">
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
                Slack rejected the saved connection (it may have been revoked, or it needs a
                permission that was added since. Reconnect to fix it.
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
            <FormField label="Default channel ID" htmlFor="slack-channel" className="max-w-sm">
              <div className="flex gap-2">
                <Input
                  id="slack-channel"
                  data-testid="slack-channel"
                  value={channel}
                  onChange={(e) => setChannel(e.target.value)}
                  placeholder="C0123ABC456"
                  className="flex-1 font-mono"
                />
                <Button
                  data-testid="slack-channel-save"
                  variant="default"
                  size="sm"
                  onClick={saveChannel}
                  loading={saveCh.isPending}
                >
                  Save
                </Button>
              </div>
            </FormField>
            <p className="text-sm text-muted-foreground">
              Find a channel ID in Slack: open the channel, click its name, and copy the ID at the
              bottom. Invite the Derive app to that channel.
            </p>
            <div>
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
          </div>
        ) : (
          <div className="flex flex-col items-start gap-3 py-1">
            <p className="text-sm text-muted-foreground">
              Connect a Slack workspace to get comments in a channel and reply back from Slack.
            </p>
            <Button data-testid="slack-connect" variant="default" asChild>
              <a href="/v1/slack/install">Add to Slack</a>
            </Button>
            <p className="text-xs text-muted-foreground">
              Haven't created the Slack app yet?{" "}
              <a
                className="underline"
                href="/settings/slack/app/new"
                data-testid="slack-setup-link"
              >
                Set it up from a manifest
              </a>
              .
            </p>
          </div>
        )}
      </SettingsGroup>
    </SettingsSection>
  )
}
