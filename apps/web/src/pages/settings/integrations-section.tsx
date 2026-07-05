import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { api, type OrgSettings } from "@/api"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { FormField } from "@/components/shared/form-field"
import { SettingRow } from "@/components/shared/setting-row"
import { SettingsGroup } from "@/components/shared/settings-group"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { toast } from "@/components/ui/sonner"
import { Switch } from "@/components/ui/switch"
import { slackQuery, workspaceSettingsQuery } from "@/lib/queries"
import { SettingsListSkeleton } from "./settings-list-skeleton"
import { SettingsSection } from "./settings-section"

// Grouped Slack event toggles for the connected app. Each group flips one or more
// event keys together (see the server's WEBHOOK_EVENTS); comment posts stay under the
// separate "Post activity to Slack" switch.
const SLACK_EVENT_GROUPS: { id: string; label: string; description: string; events: string[] }[] = [
  {
    id: "versions",
    label: "Version publishes",
    description: "Post a card when a new version is published.",
    events: ["version.published"],
  },
  {
    id: "proposals",
    label: "Proposals",
    description: "New proposals, plus approvals and change requests.",
    events: ["proposal.created", "proposal.approved", "proposal.changes_requested"],
  },
  {
    id: "reviews",
    label: "Reviews",
    description: "Review requested, approved, and sent back.",
    events: ["review.requested", "review.approved", "review.sent_back"],
  },
  {
    id: "resolutions",
    label: "Thread resolutions",
    description: "When a comment thread is resolved or reopened.",
    events: ["comment.resolved"],
  },
]

// The five workspace activity channels (email + GitHub mirroring + Slack posting)
// as instant toggles, plus the Slack connection. Toggles apply optimistically
// with no save (the toggle contract); the Slack channel id is an explicit save.
export function IntegrationsSection() {
  const qc = useQueryClient()
  const { data: settings } = useQuery(workspaceSettingsQuery())
  const { data: slack } = useQuery(slackQuery())
  const [channel, setChannel] = useState("")
  const [disconnecting, setDisconnecting] = useState(false)

  // Seed the editable channel id from the Slack status once it loads.
  useEffect(() => {
    if (slack) setChannel(slack.default_channel ?? "")
  }, [slack])

  // Optimistically flip a toggle in the cache, persisting the single key; revert on
  // error. Reads/writes the shared settings cache entry so the switch stays live.
  const flip = (key: keyof OrgSettings) => (next: boolean) => {
    const qk = workspaceSettingsQuery().queryKey
    const prev = qc.getQueryData(qk)
    if (!prev) return
    qc.setQueryData(qk, { ...prev, [key]: next })
    api
      .updateWorkspaceSettings({ [key]: next })
      .then((s) => qc.setQueryData(qk, s))
      .catch((e) => {
        qc.setQueryData(qk, prev)
        toast.error(e?.message ?? "Could not save")
      })
  }

  // Flip a group of Slack event keys together (absent key = on), persisting the whole
  // slackEvents map. Same optimistic-with-revert contract as `flip`.
  const flipEvents = (events: string[]) => (next: boolean) => {
    const qk = workspaceSettingsQuery().queryKey
    const prev = qc.getQueryData(qk)
    if (!prev) return
    const slackEvents = { ...(prev.slackEvents ?? {}) }
    for (const e of events) slackEvents[e] = next
    qc.setQueryData(qk, { ...prev, slackEvents })
    api
      .updateWorkspaceSettings({ slackEvents })
      .then((s) => qc.setQueryData(qk, s))
      .catch((e) => {
        qc.setQueryData(qk, prev)
        toast.error(e?.message ?? "Could not save")
      })
  }
  // A group reads as on unless every member event is explicitly turned off.
  const eventsOn = (events: string[]) => events.some((e) => settings?.slackEvents?.[e] !== false)

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
        qc.invalidateQueries({ queryKey: slackQuery().queryKey })
        qc.invalidateQueries({ queryKey: workspaceSettingsQuery().queryKey })
      })
      .catch((e) => {
        toast.error(e?.message ?? "Could not disconnect")
      })
  const unlinkSlack = () =>
    api
      .unlinkSlack()
      .then(() => {
        toast.success("Slack account unlinked")
        qc.invalidateQueries({ queryKey: slackQuery().queryKey })
      })
      .catch((e) => toast.error(e?.message ?? "Could not unlink"))

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
              htmlFor="slack-link"
              label="Your Slack account"
              description="Link your Slack identity so actions and notifications can act as you."
            >
              {slack.linked ? (
                <Button
                  id="slack-link"
                  data-testid="slack-unlink"
                  variant="outline"
                  size="sm"
                  onClick={unlinkSlack}
                >
                  Unlink
                </Button>
              ) : (
                <Button
                  id="slack-link"
                  data-testid="slack-link"
                  variant="default"
                  size="sm"
                  asChild
                >
                  <a href="/v1/slack/link">Link Slack account</a>
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
                >
                  Save
                </Button>
              </div>
            </FormField>
            <p className="text-sm text-muted-foreground">
              Find a channel ID in Slack: open the channel, click its name, and copy the ID at the
              bottom. Invite the Derive app to that channel.
            </p>
            {settings && (
              <SettingsGroup title="What Derive posts">
                {SLACK_EVENT_GROUPS.map((g) => (
                  <SettingRow
                    key={g.id}
                    htmlFor={`toggle-slack-${g.id}`}
                    label={g.label}
                    description={g.description}
                  >
                    <Switch
                      id={`toggle-slack-${g.id}`}
                      data-testid={`toggle-slack-${g.id}`}
                      checked={eventsOn(g.events)}
                      onCheckedChange={flipEvents(g.events)}
                    />
                  </SettingRow>
                ))}
              </SettingsGroup>
            )}
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
