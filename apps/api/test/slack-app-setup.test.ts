import { describe, expect, it } from "vitest"
import { slackOidcAuthorizeUrl } from "../src/lib/slack"
import { SLACK_CAPTURE_CALLBACK } from "../src/lib/slack-capture"
import { buildSlackManifest } from "../src/slack-app-setup"

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

  // message.im and im:history travel TOGETHER, in both directions.
  //
  // Slack refuses a manifest that subscribes the event without the scope, which is how this was
  // broken once before. It was then fixed by dropping the event, because nothing could answer a
  // DM: every reply was keyed on a slack_thread_link (channel + thread_ts) that only the channel
  // comment-mirror ever wrote. Now /v1/slack/events routes a DM straight into the chat lane, so
  // the event has a reader and the scope earns its place on the consent screen.
  //
  // Asserted as a PAIR rather than individually: either one alone is a bug — the event without
  // the scope is an app that cannot be created, and the scope without the event is asking to
  // read people's DMs for nothing.
  it("subscribes message.im and asks for im:history together", () => {
    expect(m.settings.event_subscriptions.bot_events).toContain("message.im")
    expect(m.oauth_config.scopes.bot).toContain("im:history")
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

  // Regression: this field shipped at 156 chars, and Slack rejects the WHOLE manifest over
  // 140 (invalid_manifest / failed_constraint on /display_information/description). The app
  // could not be created from it at all — caught only by posting the real manifest to
  // apps.manifest.validate. The name cap above was pinned; this neighbouring one was not.
  it("keeps the description within Slack's 140-char manifest cap", () => {
    expect(m.display_information.description.length).toBeLessThanOrEqual(140)
  })
})
