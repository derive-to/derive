import { describe, expect, it } from "vitest"
import { buildSlackManifest, slackSetupHTML } from "../src/slack-app-setup"

const BASE = "https://api.derive.example.com"

describe("buildSlackManifest", () => {
  const m = buildSlackManifest(BASE)

  it("fills every URL with the instance origin — no <BASE_URL> placeholder survives", () => {
    // The whole point: a self-hoster never hand-edits a placeholder (the gap that
    // left reply-back dead). Serialize and assert the token is gone entirely.
    expect(JSON.stringify(m)).not.toContain("<BASE_URL>")
    expect(m.oauth_config.redirect_urls).toEqual([`${BASE}/v1/slack/oauth/callback`])
    expect(m.settings.event_subscriptions.request_url).toBe(`${BASE}/v1/slack/events`)
  })

  it("is born with the events that drive two-way comment sync", () => {
    // message.channels/groups/im back reply-back across public, private, and DM channels.
    expect(m.settings.event_subscriptions.bot_events).toEqual(
      expect.arrayContaining(["message.channels", "message.groups", "message.im"]),
    )
  })

  it("declares the scopes posting, reply-back, and mention-DM email resolution need", () => {
    expect(m.oauth_config.scopes.bot).toEqual(
      expect.arrayContaining(["chat:write", "channels:history", "users:read.email", "im:write"]),
    )
  })

  it("declares private-channel history scopes to match the message.groups subscription", () => {
    // groups:* is what makes reply-back work in a private channel the bot is invited to;
    // subscribing to message.groups without it (the old gap) silently dropped those replies.
    expect(m.oauth_config.scopes.bot).toEqual(
      expect.arrayContaining(["groups:read", "groups:history"]),
    )
  })

  it("is named just Derive (Slack caps the app name at 35 chars)", () => {
    expect(m.display_information.name).toBe("Derive")
    expect(m.display_information.name.length).toBeLessThanOrEqual(35)
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
