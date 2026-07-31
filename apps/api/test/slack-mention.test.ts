import { describe, expect, it } from "vitest"
import { SLACK_BOT_SCOPES } from "../src/lib/slack"
import { artifactRefIn, questionFrom } from "../src/lib/slack-mention"
import { buildSlackManifest } from "../src/slack-app-setup"

// @Derive IN SLACK. The pure halves — what the model is actually asked, and which document the
// message pointed at — plus the manifest pairing that has now been the cause of two shipped
// Slack defects (an event without its scope, and a declaration in the wrong section).

describe("the question a Slack mention asks", () => {
  it("strips the bot token so the model reads the question, not the wire format", () => {
    expect(questionFrom("<@U123> what does pricing say?", "U123")).toBe("what does pricing say?")
    // A mention can land mid-sentence, or twice.
    expect(questionFrom("hey <@U123> can you check <@U123> the roadmap", "U123")).toBe(
      "hey can you check the roadmap",
    )
  })

  it("leaves other people's mentions alone — they are part of the question", () => {
    expect(questionFrom("<@U123> ask <@U999> about it", "U123")).toBe("ask <@U999> about it")
  })

  it("is empty when the message is only a mention, so the lane can say so instead of guessing", () => {
    expect(questionFrom("<@U123>", "U123")).toBe("")
    expect(questionFrom("  <@U123>   ", "U123")).toBe("")
  })
})

describe("the document a Slack mention points at", () => {
  const base = "https://derive.test"

  it("finds the short_id in a pasted artifact URL", () => {
    expect(
      artifactRefIn("what about https://derive.test/artifacts/pricing-faq-8myxva5b ?", base),
    ).toBe("8myxva5b")
  })

  it("finds it in Slack's angle-bracket link form, with or without a label", () => {
    expect(artifactRefIn("<https://derive.test/artifacts/q3-roadmap-e3xkasx3>", base)).toBe(
      "e3xkasx3",
    )
    expect(
      artifactRefIn("<https://derive.test/artifacts/q3-roadmap-e3xkasx3|Q3 Roadmap>", base),
    ).toBe("e3xkasx3")
  })

  it("ignores a link to a DIFFERENT host, which is not this deploy's document", () => {
    expect(artifactRefIn("https://evil.example/artifacts/pricing-faq-8myxva5b", base)).toBeNull()
  })

  it("returns null when no artifact is named", () => {
    expect(artifactRefIn("what does the pricing doc say?", base)).toBeNull()
    expect(artifactRefIn("https://derive.test/settings", base)).toBeNull()
  })
})

describe("the Slack app manifest", () => {
  const manifest = buildSlackManifest("https://derive.test") as {
    oauth_config: { scopes: { bot: string[] } }
    settings: { event_subscriptions: { bot_events: string[] } }
  }

  it("declares app_mention AND its scope together", () => {
    // Slack refuses a manifest that subscribes to an event without the scope that grants it, and
    // the failure is at INSTALL time — which is how two Slack defects have already shipped. The
    // pairing is asserted rather than trusted to a comment.
    expect(manifest.settings.event_subscriptions.bot_events).toContain("app_mention")
    expect(manifest.oauth_config.scopes.bot).toContain("app_mentions:read")
    expect(SLACK_BOT_SCOPES).toContain("app_mentions:read")
  })

  it("still declares chat:write — the mention lane answers by posting", () => {
    expect(manifest.oauth_config.scopes.bot).toContain("chat:write")
  })
})
