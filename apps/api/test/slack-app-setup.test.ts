import { describe, expect, it } from "vitest"
import { buildSlackManifest, slackSetupHTML } from "../src/slack-app-setup"

const BASE = "https://api.derive.example.com"

describe("buildSlackManifest", () => {
  const m = buildSlackManifest(BASE)

  it("fills every URL with the instance origin — no <BASE_URL> placeholder survives", () => {
    // The whole point: a self-hoster never hand-edits a placeholder (the gap that
    // left reply-back dead). Serialize and assert the token is gone entirely.
    expect(JSON.stringify(m)).not.toContain("<BASE_URL>")
    expect(m.oauth_config.redirect_urls).toEqual([
      `${BASE}/v1/slack/oauth/callback`,
      `${BASE}/v1/slack/link/callback`,
    ])
    expect(m.settings.event_subscriptions.request_url).toBe(`${BASE}/v1/slack/events`)
  })

  it("is born with the events that drive two-way comment sync", () => {
    // message.channels/groups back reply-back across public and private channels.
    expect(m.settings.event_subscriptions.bot_events).toEqual(
      expect.arrayContaining(["message.channels", "message.groups"]),
    )
  })

  // Regression: message.im was subscribed but is unreachable — /v1/slack/events keys every
  // reply on a slack_thread_link (channel + thread_ts) and only the channel comment-mirror
  // writes those, never slack-dm.ts. Slack rejected the manifest over the missing im:history
  // scope, and granting it would mean asking to READ users' DMs for a path that ignores them.
  it("does not subscribe to DM messages it cannot act on (and so needs no im:history)", () => {
    expect(m.settings.event_subscriptions.bot_events).not.toContain("message.im")
    expect(m.oauth_config.scopes.bot).not.toContain("im:history")
  })

  it("declares the scopes posting, reply-back, and mention-DM email resolution need", () => {
    expect(m.oauth_config.scopes.bot).toEqual(
      expect.arrayContaining(["chat:write", "channels:history", "users:read.email", "im:write"]),
    )
  })

  // Regression: /derive shipped in #454 but `commands` was never added, so Slack refused the
  // manifest ("Slash Commands requires `commands` bot scope") — the app was uncreatable.
  it("declares the commands scope its slash command requires", () => {
    expect(m.oauth_config.scopes.bot).toContain("commands")
  })

  it("declares private-channel history scopes to match the message.groups subscription", () => {
    // groups:* is what makes reply-back work in a private channel the bot is invited to;
    // subscribing to message.groups without it (the old gap) silently dropped those replies.
    expect(m.oauth_config.scopes.bot).toEqual(
      expect.arrayContaining(["groups:read", "groups:history"]),
    )
  })

  it("enables interactivity pointed at this instance (comment-card buttons post here)", () => {
    expect(m.settings.interactivity.is_enabled).toBe(true)
    expect(m.settings.interactivity.request_url).toBe(`${BASE}/v1/slack/interactivity`)
  })

  it("declares the /derive slash command pointed at this instance", () => {
    const cmd = m.features.slash_commands?.[0]
    expect(cmd?.command).toBe("/derive")
    expect(cmd?.url).toBe(`${BASE}/v1/slack/commands`)
  })

  it("is named just Derive (Slack caps the app name at 35 chars)", () => {
    expect(m.display_information.name).toBe("Derive")
    expect(m.display_information.name.length).toBeLessThanOrEqual(35)
  })

  // Regression: this field shipped at 156 chars, and Slack rejects the WHOLE manifest over
  // 140 (invalid_manifest / failed_constraint on /display_information/description). The app
  // could not be created from it at all — caught only by posting the real manifest to
  // apps.manifest.validate. The name cap above was pinned; this neighbouring one was not.
  it("keeps the description within Slack's 140-char manifest cap", () => {
    expect(m.display_information.description.length).toBeLessThanOrEqual(140)
  })
})

describe("slackSetupHTML", () => {
  it("renders the filled manifest for copy-paste with the three setup steps", () => {
    const html = slackSetupHTML(BASE)
    expect(html).toContain("Create your Slack app")
    expect(html).toContain(`${BASE}/v1/slack/events`)
    expect(html).not.toContain("<BASE_URL>")
    // The copy target + the dashboard link are both present.
    expect(html).toContain('id="mf"')
    expect(html).toContain("api.slack.com/apps")
  })
})
