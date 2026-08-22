import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { api } from "@/api"
import { LoadError } from "@/components/shared/load-error"
import { SettingRow } from "@/components/shared/setting-row"
import { SettingsGroup } from "@/components/shared/settings-group"
import { StatusPanel } from "@/components/shared/status-panel"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { slackQuery } from "@/lib/queries"
import { STORAGE_KEYS } from "@/lib/storage-keys"
import { snapshot, useApiMutation } from "@/lib/use-api-mutation"
import { useOneShotParams } from "@/lib/use-one-shot-params"
import { SettingsListSkeleton } from "./settings-list-skeleton"
import { SettingsSection } from "./settings-section"

// How Derive gets YOUR attention — and nothing else. Everything on this page is
// scoped to the caller: the Slack DM preference is per-user-per-workspace
// (user_notification_pref), the account link is per-user, and auto-open is per
// device. The workspace-wide switches (does this workspace email anyone at all,
// does it mirror to GitHub) stay under Integrations — a workspace decision must
// not dress up as a personal one.
//
// The Slack DM pref is deliberately settable BEFORE the workspace connects Slack
// (the server allows it); only the test DM and account link need a live
// connection, so those affordances follow `slack.connected`.
const LINK_ERRORS: Record<string, string> = {
  not_connected: "Slack isn't connected for this workspace yet, so there's nothing to link.",
  link: "Couldn’t link your Slack account. Try again in a moment.",
  link_team:
    "That Slack account belongs to a different workspace's Slack. Sign into the right Slack workspace and try again.",
}

export function NotificationsSection() {
  const { data: slack, isError, refetch } = useQuery(slackQuery())
  // The account-link flow bounces back here with ?error=… on failure; success
  // needs no banner (the row itself flips to "Linked").
  const { error: linkError } = useOneShotParams("error")

  // Optimistically flip the caller's Slack-DM preference in the shared slack cache.
  const slackDm = useApiMutation({
    mutationFn: (next: boolean) => api.setSlackDm(next),
    optimistic: (next, client) => {
      const qk = slackQuery().queryKey
      const rollback = snapshot(client, qk)
      client.setQueryData(qk, (prev) => (prev ? { ...prev, slack_dm: next } : prev))
      return rollback
    },
  })
  const reviewEmail = useApiMutation({
    mutationFn: (next: boolean) => api.setReviewEmail(next),
    optimistic: (next, client) => {
      const qk = slackQuery().queryKey
      const rollback = snapshot(client, qk)
      client.setQueryData(qk, (prev) => (prev ? { ...prev, review_email: next } : prev))
      return rollback
    },
  })
  const testDm = useApiMutation({
    mutationFn: () => api.sendSlackTestDm(),
    success: "Test DM sent",
  })
  const unlink = useApiMutation({
    mutationFn: () => api.unlinkSlack(),
    success: "Slack account unlinked",
    invalidate: [slackQuery().queryKey],
  })

  // Auto-open is per device on purpose: yanking navigation is fine on your own
  // laptop, hostile on a shared screen. Absent key reads as ON (no migration).
  const [autoOpen, setAutoOpen] = useState(
    () => localStorage.getItem(STORAGE_KEYS.autoOpen) !== "off",
  )
  const flipAutoOpen = (on: boolean) => {
    setAutoOpen(on)
    if (on) localStorage.removeItem(STORAGE_KEYS.autoOpen)
    else localStorage.setItem(STORAGE_KEYS.autoOpen, "off")
  }

  const connected = !!slack?.connected

  return (
    <SettingsSection
      title="Notifications"
      description="Choose how Derive notifies you. These settings do not affect your teammates or workspace notifications."
    >
      {linkError && LINK_ERRORS[linkError] && (
        <StatusPanel
          tone={linkError === "not_connected" ? "warning" : "danger"}
          layout="inline"
          title="Slack account not linked"
          description={LINK_ERRORS[linkError]}
        />
      )}

      <SettingsGroup title="Slack">
        {/* Wait for the status before offering the switch: an optimistic flip
            against an empty cache no-ops (the switch wouldn't move), and a
            connected workspace would flash the not-connected copy. */}
        {!slack ? (
          // Padding-neutral wrappers: SettingsGroup strips first/last child padding.
          isError ? (
            <div>
              <LoadError
                title="Couldn’t load your Slack status"
                testId="notifications-slack-retry"
                onRetry={() => refetch()}
              />
            </div>
          ) : (
            <div>
              <SettingsListSkeleton rows={2} />
            </div>
          )
        ) : !slack.available ? (
          <SettingRow
            label="Send important updates in Slack"
            description="Slack is not set up on this server yet."
          >
            <Switch id="toggle-slack-dm" data-testid="toggle-slack-dm" checked={false} disabled />
          </SettingRow>
        ) : (
          <>
            <SettingRow
              htmlFor="toggle-slack-dm"
              label="Send important updates in Slack"
              description={
                connected
                  ? "Get a Slack direct message when an agent finishes work, someone mentions you, requests your review, or shares a document with you. Link your Slack account below so Derive knows where to send it."
                  : "A Slack direct message when an agent finishes work, someone @mentions you, requests your review, or shares a doc with you. Takes effect once an admin connects Slack under Integrations."
              }
            >
              <div className="flex items-center gap-2">
                {connected && (
                  <Button
                    data-testid="slack-test-dm"
                    variant="outline"
                    size="sm"
                    onClick={() => testDm.mutate()}
                    loading={testDm.isPending}
                  >
                    Send test DM
                  </Button>
                )}
                <Switch
                  id="toggle-slack-dm"
                  data-testid="toggle-slack-dm"
                  checked={slack?.slack_dm ?? true}
                  onCheckedChange={(next) => slackDm.mutate(next)}
                />
              </div>
            </SettingRow>
            {connected ? (
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
                    onClick={() => unlink.mutate()}
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
            ) : (
              <SettingRow
                label="Your Slack account"
                description={
                  <>
                    Linking becomes available once Slack is connected for this workspace, under{" "}
                    <Link
                      to="/settings/$section"
                      params={{ section: "integrations" }}
                      className="text-primary underline underline-offset-2"
                    >
                      Integrations
                    </Link>
                    .
                  </>
                }
              >
                <Button data-testid="slack-link-unavailable" variant="outline" size="sm" disabled>
                  Link account
                </Button>
              </SettingRow>
            )}
          </>
        )}
      </SettingsGroup>

      <SettingsGroup title="Email">
        {!slack ? (
          <div>
            <SettingsListSkeleton rows={1} />
          </div>
        ) : (
          <SettingRow
            htmlFor="toggle-review-email"
            label="Email me review requests"
            description="Off by default. Turn this on when you also want review requests in your inbox. A workspace admin must keep email delivery enabled."
          >
            <Switch
              id="toggle-review-email"
              data-testid="toggle-review-email"
              checked={slack.review_email ?? false}
              onCheckedChange={(next) => reviewEmail.mutate(next)}
            />
          </SettingRow>
        )}
      </SettingsGroup>

      <SettingsGroup title="Activity">
        <SettingRow
          htmlFor="toggle-auto-open"
          label="Open new agent publications automatically"
          description="When your connected coding agent publishes a new artifact, open it in this tab. This setting is saved in this browser."
        >
          <Switch
            id="toggle-auto-open"
            data-testid="toggle-auto-open"
            checked={autoOpen}
            onCheckedChange={flipAutoOpen}
          />
        </SettingRow>
      </SettingsGroup>
    </SettingsSection>
  )
}
