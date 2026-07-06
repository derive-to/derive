import { describe, expect, it } from "vitest"
import { buildSlackManifest, hostOf, slackSetupHTML } from "../src/slack-app-setup"

const BASE = "https://api.derive.example.com"

describe("buildSlackManifest", () => {
  const m = buildSlackManifest(BASE, hostOf(BASE))

  it("fills every URL with the instance origin — no <BASE_URL> placeholder survives", () => {
    // The whole point: a self-hoster never hand-edits a placeholder (the gap that
    // left reply-back dead). Serialize and assert the token is gone entirely.
    expect(JSON.stringify(m)).not.toContain("<BASE_URL>")
    expect(m.oauth_config.redirect_urls).toEqual([
      `${BASE}/v1/slack/oauth/callback`,
      `${BASE}/v1/slack/link/callback`,
    ])
    expect(m.settings.event_subscriptions.request_url).toBe(`${BASE}/v1/slack/events`)
    expect(m.settings.interactivity.request_url).toBe(`${BASE}/v1/slack/interactivity`)
    expect(m.features.slash_commands[0]?.url).toBe(`${BASE}/v1/slack/command`)
  })

  it("is born with the events that drive two-way sync + App Home", () => {
    // message.channels backs reply-back; app_home_opened publishes the home view.
    expect(m.settings.event_subscriptions.bot_events).toEqual(
      expect.arrayContaining(["message.channels", "app_mention", "link_shared", "app_home_opened"]),
    )
    expect(m.settings.interactivity.is_enabled).toBe(true)
    expect(m.features.app_home.home_tab_enabled).toBe(true)
  })

  it("declares the scopes + slash command + unfurl domain the features need", () => {
    expect(m.oauth_config.scopes.bot).toEqual(
      expect.arrayContaining(["chat:write", "channels:history", "commands", "links:read"]),
    )
    expect(m.features.slash_commands[0]?.command).toBe("/derive")
    // link_shared only fires for domains listed here — this deployment's own host.
    expect(m.features.unfurl_domains).toEqual([hostOf(BASE)])
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
