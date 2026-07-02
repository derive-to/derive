import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"
import { api, type OrgSettings, type SlackStatus } from "@/api"
import { Spinner } from "@/components/shared/spinner"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"

/** A labelled on/off switch backed by a button (so it carries a testid + is keyboard
 *  reachable). Colours come from theme tokens only. */
function Toggle(props: {
  id: string
  label: string
  hint: string
  on: boolean
  disabled?: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div>
        <div className="text-sm font-medium">{props.label}</div>
        <div className="text-sm text-muted-foreground">{props.hint}</div>
      </div>
      <Switch
        checked={props.on}
        disabled={props.disabled}
        data-testid={`toggle-${props.id}`}
        aria-label={props.label}
        onCheckedChange={props.onChange}
        className="mt-1"
      />
    </div>
  )
}

export function IntegrationsSection() {
  const [settings, setSettings] = useState<OrgSettings | null>(null)
  const [slack, setSlack] = useState<SlackStatus | null>(null)
  const [channel, setChannel] = useState("")

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
  const disconnectSlack = () => {
    api
      .disconnectSlack()
      .then(() => {
        toast.success("Slack disconnected")
        load()
      })
      .catch((e) => toast.error(e?.message ?? "Could not disconnect"))
  }

  if (!settings) {
    return (
      <div className="flex h-20 items-center justify-center">
        <Spinner />
      </div>
    )
  }

  return (
    <section className="flex flex-col gap-6">
      <div>
        <p className="mb-2 text-sm text-muted-foreground">
          Turn each integration channel on or off for this workspace.
        </p>
        <Card className="divide-y px-4 py-1">
          <Toggle
            id="email"
            label="Email notifications"
            hint="Email collaborators when a comment mentions them or lands on a thread they're in."
            on={settings.emailNotifications}
            onChange={flip("emailNotifications")}
          />
          <Toggle
            id="github-post"
            label="Post comments to GitHub"
            hint="When you comment on a PR-sourced doc, mirror it onto the pull request."
            on={settings.githubPostComments}
            onChange={flip("githubPostComments")}
          />
          <Toggle
            id="github-mirror"
            label="Mirror PR comments into Derive"
            hint="Comments made on the pull request show up on the Derive artifact."
            on={settings.githubMirrorComments}
            onChange={flip("githubMirrorComments")}
          />
          <Toggle
            id="github-preview-link"
            label="Comment a preview link on PRs"
            hint="When a pull request opens, post (and keep updated) a comment linking to the Derive preview of its docs."
            on={settings.githubPreviewLink}
            onChange={flip("githubPreviewLink")}
          />
          <Toggle
            id="slack-post"
            label="Post activity to Slack"
            hint="Send comments to the connected Slack channel; replies there post back to Derive."
            on={settings.slackPost}
            onChange={flip("slackPost")}
          />
        </Card>
      </div>

      <div>
        <h2 className="mb-1 text-sm font-semibold">Slack</h2>
        {slack && !slack.available ? (
          <p className="text-sm text-muted-foreground">
            Slack isn't configured on this Derive instance.
          </p>
        ) : slack?.connected ? (
          <Card className="flex flex-col gap-3 p-4">
            <p className="text-sm">
              Connected to{" "}
              <span className="font-medium">{slack.team_name ?? "your Slack workspace"}</span>.
            </p>
            <div className="flex items-end gap-2">
              <div className="flex-1 text-sm">
                <label htmlFor="slack-channel" className="mb-1 block text-muted-foreground">
                  Default channel ID
                </label>
                <Input
                  id="slack-channel"
                  data-testid="slack-channel"
                  value={channel}
                  onChange={(e) => setChannel(e.target.value)}
                  placeholder="C0123ABC456"
                />
              </div>
              <Button data-testid="slack-channel-save" variant="default" onClick={saveChannel}>
                Save
              </Button>
            </div>
            <p className="text-sm text-muted-foreground">
              Find a channel ID in Slack: open the channel, click its name, and copy the ID at the
              bottom. Invite the Derive app to that channel.
            </p>
            <div>
              <Button data-testid="slack-disconnect" variant="outline" onClick={disconnectSlack}>
                Disconnect Slack
              </Button>
            </div>
          </Card>
        ) : (
          <Card className="flex flex-col items-start gap-3 p-4">
            <p className="text-sm text-muted-foreground">
              Connect a Slack workspace to get comments in a channel and reply back from Slack.
            </p>
            <Button data-testid="slack-connect" variant="default" asChild>
              <a href="/v1/slack/install">Add to Slack</a>
            </Button>
          </Card>
        )}
      </div>
    </section>
  )
}
