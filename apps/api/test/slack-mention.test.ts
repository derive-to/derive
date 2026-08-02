import { describe, expect, it } from "vitest"
import { SLACK_BOT_SCOPES } from "../src/lib/slack"
import { mrkdwnBody } from "../src/lib/slack-cards"
import {
  artifactRefIn,
  identityVerdict,
  MISS_TTL_MS,
  parseSlackTs,
  questionFrom,
} from "../src/lib/slack-mention"
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

  it("refuses a LOOKALIKE host — the escape has to actually escape", () => {
    // The host goes into a RegExp, so its dots must be escaped or they are wildcards. This
    // shipped broken once: the character class was malformed and escaped nothing, so
    // `derive-prXderive-toXworkersXdev` matched. Bounded by the org check downstream, but a
    // host match that is not a host match is worth pinning.
    expect(
      artifactRefIn("https://derive-pr-609Xderive-toXworkersXdev/artifacts/faq-8myxva5b", base),
    ).toBeNull()
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

// HOW AN ANSWER LOOKS IN SLACK. The model writes markdown; Slack speaks mrkdwn. Escaping alone
// left every citation as literal `[Title](/artifacts/x)` — the most useful part of an answer
// rendered as punctuation — which no test caught because the STRING was correct.

describe("an answer rendered for Slack", () => {
  const BASE = "https://derive.example"
  // The transform the lane applies before mrkdwnBody: citations are root-relative by design
  // (the agent cites by path, knowing no hostname) and mean nothing to Slack until absolutised.
  const absolutise = (md: string) =>
    md.replace(/\]\((\/[A-Za-z0-9][\w\-./?=&#%]*)\)/g, (_m, p: string) => `](${BASE}${p})`)

  it("turns a root-relative citation into a clickable Slack link", () => {
    const out = mrkdwnBody(absolutise("See the [Q3 Roadmap](/artifacts/k9ffftpm) for dates."))
    expect(out).toContain(`<${BASE}/artifacts/k9ffftpm|Q3 Roadmap>`)
    expect(out).not.toContain("](")
  })

  it("leaves an absolute link alone", () => {
    const out = mrkdwnBody(absolutise("See [the docs](https://example.com/x)."))
    expect(out).toContain("<https://example.com/x|the docs>")
  })

  it("does NOT absolutise a protocol-relative or javascript target", () => {
    // The pattern is the guard: a leading slash then an ALPHANUMERIC admits /artifacts/x and
    // excludes both `//evil.com` and `javascript:`.
    expect(absolutise("[x](//evil.com)")).toBe("[x](//evil.com)")
    expect(absolutise("[x](javascript:alert(1))")).toBe("[x](javascript:alert(1))")
  })

  it("still neutralises a channel-wide mention hidden in an answer", () => {
    // The escaping this replaced existed for a reason; rendering must not lose it.
    expect(mrkdwnBody(absolutise("hello <!channel> there"))).not.toContain("<!channel>")
  })
})

// WHAT A STORED IDENTITY ROW MAKES US DO NEXT. Extracted and tested pure because the lane
// around it needs Slack, a model and a store — and because these branches fail QUIETLY: too
// eager re-asks Slack on every message, too sticky writes somebody off for ever.

describe("deciding whether to look up an identity again", () => {
  const NOW = Date.UTC(2026, 7, 1, 12, 0, 0)
  const ago = (ms: number) => new Date(NOW - ms).toISOString()
  const miss = (checked_at: string | null) => ({ origin: "miss", checked_at })

  it("uses a real link, whatever its age", () => {
    // A link does not go stale. Only a miss has a shelf life.
    expect(identityVerdict({ origin: "oauth", checked_at: ago(400 * 24 * 3600_000) }, NOW)).toBe(
      "use",
    )
    expect(identityVerdict({ origin: "email", checked_at: null }, NOW)).toBe("use")
  })

  it("stays silent on a miss inside the window", () => {
    expect(identityVerdict(miss(ago(60_000)), NOW)).toBe("silent")
    expect(identityVerdict(miss(ago(MISS_TTL_MS - 1000)), NOW)).toBe("silent")
  })

  it("looks again once the miss has aged out", () => {
    // The point of expiry: somebody who joined Derive since should start working without
    // anyone intervening.
    expect(identityVerdict(miss(ago(MISS_TTL_MS + 1000)), NOW)).toBe("look")
  })

  it("looks when there is no row at all", () => {
    expect(identityVerdict(null, NOW)).toBe("look")
  })

  it("looks when the stamp is missing or unreadable, rather than going silent", () => {
    // The dangerous direction is silence. A row that predates checked_at, or one with a
    // corrupt stamp, must not read as "recently checked, say nothing".
    expect(identityVerdict(miss(null), NOW)).toBe("look")
    expect(identityVerdict(miss("not a date"), NOW)).toBe("look")
  })

  it("looks when the stamp is in the FUTURE, so clock skew cannot silence us", () => {
    expect(identityVerdict(miss(new Date(NOW + 60_000).toISOString()), NOW)).toBe("look")
  })
})

describe("recognising a redelivered Slack message", () => {
  it("reads the ts marker written alongside the message", () => {
    expect(parseSlackTs(JSON.stringify({ slack: { ts: "1720000000.1" } }))).toBe("1720000000.1")
  })

  it("treats absent or unreadable meta as NOT SEEN", () => {
    // Erring here costs one duplicate answer; the opposite error drops a real question on the
    // floor, so every ambiguous case has to mean "not seen".
    expect(parseSlackTs(null)).toBeNull()
    expect(parseSlackTs(undefined)).toBeNull()
    expect(parseSlackTs("{oops")).toBeNull()
    expect(parseSlackTs(JSON.stringify({ outcome: "answered" }))).toBeNull()
  })
})
