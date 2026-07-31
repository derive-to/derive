import { describe, expect, it } from "vitest"
import { slackOidcAuthorizeUrl } from "../src/lib/slack"
import { SLACK_CAPTURE_CALLBACK } from "../src/lib/slack-capture"
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
  // The manifest lists /v1/slack/link/callback as a redirect URL, so an app built from it LOOKS
  // configured for account linking. Without the user scopes it refuses the first authorize call
  // a member makes, and nothing about the install hints at it. The live app carried these only
  // because someone added them by hand; the generator omitted them entirely.
  it("declares the user scopes Sign in with Slack needs, not just the bot ones", () => {
    expect(m.oauth_config.scopes.user).toEqual(["openid", "profile", "email"])
    expect(m.oauth_config.redirect_urls).toContain(`${BASE}/v1/slack/link/callback`)
  })

  // The authorize URL and the manifest must ask for the SAME set — a scope in one and not the
  // other fails at the point of use, long after install.
  it("asks for exactly the scopes its own authorize URL sends", () => {
    const sent = new URL(slackOidcAuthorizeUrl("cid", `${BASE}/cb`, "st", "nonce")).searchParams
    expect(sent.get("scope")?.split(" ").sort()).toEqual([...m.oauth_config.scopes.user].sort())
  })

  it("declares the commands scope its slash command requires", () => {
    expect(m.oauth_config.scopes.bot).toContain("commands")
  })

  // Link unfurls. The domain entry is what makes Slack deliver link_shared at all, and it
  // covers every vanity SUBDOMAIN of the instance host as well. Unlike the events, a change
  // here only lands after the app is reinstalled in each workspace.
  it("registers the instance host as an unfurl domain and subscribes to link_shared", () => {
    expect(m.features.unfurl_domains).toEqual(["api.derive.example.com"])
    expect(m.features.unfurl_domains.length).toBeLessThanOrEqual(5)
    expect(m.settings.event_subscriptions.bot_events).toContain("link_shared")
    expect(m.oauth_config.scopes.bot).toEqual(expect.arrayContaining(["links:read", "links:write"]))
  })

  // Without these, a removed app or a revoked token is invisible until a delivery happens to
  // fail — so an idle workspace keeps claiming "connected". Neither event requires a scope.
  it("subscribes to the install-lifecycle events that invalidate the bot token", () => {
    expect(m.settings.event_subscriptions.bot_events).toEqual(
      expect.arrayContaining(["app_uninstalled", "tokens_revoked"]),
    )
  })

  it("declares private-channel history scopes to match the message.groups subscription", () => {
    // groups:history is what gates DELIVERY of message.groups, so reply-back works in a private
    // channel the bot is invited to; subscribing without it (the old gap) silently dropped those
    // replies. groups:read is held alongside it but backs no call Derive makes — see the
    // SLACK_BOT_SCOPES docstring for why it is kept rather than trimmed.
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

  // Placement, not just presence. Slack's manifest schema rejects unknown keys outright, so a
  // shortcut declared one level away — under `settings`, beside interactivity, where it reads
  // like it belongs — does not degrade to "the shortcut is missing". It fails the whole manifest,
  // and the app cannot be created or updated at all. That is exactly how this shipped, and every
  // other assertion in this file passed while it did, because they all check contents rather
  // than where the contents live.
  it("declares Save to Derive as a message shortcut under features, not settings", () => {
    expect(m.features.shortcuts).toEqual([
      {
        name: "Save to Derive",
        type: "message",
        callback_id: "derive_capture",
        description: expect.any(String),
      },
    ])
    expect((m.settings as Record<string, unknown>).shortcuts).toBeUndefined()
    // The callback_id is the contract between the manifest and the interactivity handler: Slack
    // routes a message_action by this string, so a rename on one side alone is a dead shortcut.
    expect(m.features.shortcuts[0]?.callback_id).toBe(SLACK_CAPTURE_CALLBACK)
  })

  // Slack caps a shortcut's name at 24 characters and its description at 150.
  it("keeps the shortcut inside Slack's field limits", () => {
    const s = m.features.shortcuts[0]
    expect(s?.name.length).toBeLessThanOrEqual(24)
    expect(s?.description.length).toBeLessThanOrEqual(150)
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
