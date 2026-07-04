import { useCallback, useEffect, useState } from "react"
import { api, type OrgSettings, type SlackStatus } from "@/api"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { FormField } from "@/components/shared/form-field"
import { SettingRow } from "@/components/shared/setting-row"
import { SettingsGroup } from "@/components/shared/settings-group"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { toast } from "@/components/ui/sonner"
import { Switch } from "@/components/ui/switch"
import { SettingsListSkeleton } from "./settings-list-skeleton"
import { SettingsSection } from "./settings-section"

// The five workspace activity channels (email + GitHub mirroring + Slack posting)
// as instant toggles, plus the Slack connection. Toggles apply optimistically
// with no save (the toggle contract); the Slack channel id is an explicit save.
export function IntegrationsSection() {
  const [settings, setSettings] = useState<OrgSettings | null>(null)
  const [slack, setSlack] = useState<SlackStatus | null>(null)
  const [channel, setChannel] = useState("")
  const [disconnecting, setDisconnecting] = useState(false)

  const load = useCallback(() => {
    api
      .getWorkspaceSettings()
      .then(setSettings)
      .catch(() => setSettings(null))
    api
      .getSlack()
      .then((s) => {
        setSlack(s)
        setChannel(s.default_channel ?? "")
      })
      .catch(() => setSlack(null))
  }, [])
  useEffect(() => {
    load()
  }, [load])

  // Optimistically flip a toggle, persisting the single key; revert on error.
  const flip = (key: keyof OrgSettings) => (next: boolean) => {
    if (!settings) return
    const prev = settings
    setSettings({ ...settings, [key]: next })
    api
      .updateWorkspaceSettings({ [key]: next })
      .then(setSettings)
      .catch((e) => {
        setSettings(prev)
        toast.error(e?.message ?? "Could not save")
      })
  }

  const saveChannel = () => {
    api
      .setSlackChannel(channel.trim() || null)
      .then(() => toast.success("Slack channel saved"))
      .catch((e) => toast.error(e?.message ?? "Could not save"))
  }
  const disconnectSlack = () =>
    api
      .disconnectSlack()
      .then(() => {
        toast.success("Slack disconnected")
        load()
      })
      .catch((e) => {
        toast.error(e?.message ?? "Could not disconnect")
      })

  return (
    <SettingsSection
      title="Integrations"
      description="Route comment and PR activity to the tools your team already uses. Each switch applies instantly."
    >
      {settings ? (
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
      ) : (
        <SettingsListSkeleton />
      )}

      <SettingsGroup title="Slack">
        {slack && !slack.available ? (
          <p className="py-1 text-sm text-muted-foreground">
            Slack isn't configured on this Derive instance.
          </p>
        ) : slack?.connected ? (
          <div className="flex flex-col gap-4 py-1">
            <p className="text-sm">
              Connected to{" "}
              <span className="font-medium">{slack.team_name ?? "your Slack workspace"}</span>.
            </p>
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
          </div>
        )}
      </SettingsGroup>
    </SettingsSection>
  )
}
