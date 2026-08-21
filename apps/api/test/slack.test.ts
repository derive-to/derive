import { createHmac } from "node:crypto"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type ArtifactRecord,
  newId,
  type Role,
  type SlackThreadLinkRecord,
  type SlackUserLinkRecord,
} from "@derive/core"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { describe, expect, it } from "vitest"
import { parseMeta } from "../src/lib/comments"
import { SLACK_BOT_SCOPES, slackOidcUserinfo, verifySlackSignature } from "../src/lib/slack"
import { ingestSlackReply } from "../src/lib/slack-comments"
import { chatSeatFor, isVerifiedLink } from "../src/lib/slack-identity"
import {
  artifactRefIn,
  identityVerdict,
  MISS_TTL_MS,
  parseSlackTs,
  questionFrom,
} from "../src/lib/slack-mention"
import { buildSlackManifest } from "../src/slack-app-setup"

describe("slack signature verification", () => {
  const secret = "shh"
  const sign = (ts: string, body: string) =>
    `v0=${createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex")}`

  it("accepts a correctly signed, fresh request", () => {
    const now = 1_700_000_000_000
    const ts = String(Math.floor(now / 1000))
    const body = '{"a":1}'
    expect(verifySlackSignature(secret, ts, body, sign(ts, body), now)).toBe(true)
  })

  it("rejects a bad signature, a stale timestamp, and missing headers", () => {
    const now = 1_700_000_000_000
    const ts = String(Math.floor(now / 1000))
    const body = '{"a":1}'
    expect(verifySlackSignature(secret, ts, body, "v0=deadbeef", now)).toBe(false)
    const old = String(Math.floor(now / 1000) - 1000)
    expect(verifySlackSignature(secret, old, body, sign(old, body), now)).toBe(false)
    expect(verifySlackSignature(secret, undefined, body, sign(ts, body), now)).toBe(false)
  })
})

describe("slack reply ingestion (inbound)", () => {
  const dir = mkdtempSync(join(tmpdir(), "derive-slack-"))
  const meta = new SqliteMetaStore(join(dir, "db.sqlite"))

  const setup = async () => {
    const artifact = (await meta.createArtifact({
      id: newId("a"),
      short_id: newId("s").slice(0, 8),
      org_id: "default",
      slug: null,
      title: "Doc",
      workspace_access: "member",
      link_role: "viewer",
      listed: "public",
      kind: "file",
      spa: 0,
    })) as ArtifactRecord
    const link: SlackThreadLinkRecord = {
      id: newId("stl"),
      org_id: "default",
      artifact_id: artifact.id,
      thread_id: newId("c"),
      channel: "C123",
      message_ts: `root-${newId("ts")}`,
      created_at: new Date().toISOString(),
    }
    await meta.setSlackThreadLink(link)
    return { artifact, link }
  }

  it("creates a Derive reply on the linked thread from a human Slack message", async () => {
    const { link } = await setup()
    const created = await ingestSlackReply(meta, link, {
      ts: "1700.2",
      userId: "U999",
      userName: "Dana",
      text: "looks good",
      botUserId: "UBOT",
    })
    expect(created?.author).toBe("Dana")
    expect(created?.author_id).toBe("slack:U999")
    expect(created?.thread_id).toBe(link.thread_id)
    expect(parseMeta(created?.meta ?? null).slack?.ts).toBe("1700.2")
  })

  it("skips our own bot's messages (loop prevention)", async () => {
    const { link } = await setup()
    const r = await ingestSlackReply(meta, link, {
      ts: "1700.3",
      userId: "UBOT",
      userName: "derive",
      text: "echo",
      botUserId: "UBOT",
    })
    expect(r).toBe(null)
  })

  // IDENTITY STRENGTH AT THE ATTRIBUTION SEAM. The handler passes `deriveUserId` only for an
  // oauth link (lib/slack-identity.ts); an email match arrives here as null. What matters is
  // that null DEGRADES rather than refuses — the reply is still a comment, just one that claims
  // only what we can prove. Losing the reply instead would be a worse trade than the claim.
  it("attributes to the Derive account when the link is strong enough to carry it", async () => {
    const { link } = await setup()
    const created = await ingestSlackReply(meta, link, {
      ts: "1700.5",
      userId: "U999",
      userName: "Dana",
      text: "ship it",
      botUserId: "UBOT",
      deriveUserId: "u-dana",
    })
    expect(created?.author_id).toBe("u-dana")
  })

  it("still records the reply when it cannot, under the Slack identity alone", async () => {
    const { link } = await setup()
    const created = await ingestSlackReply(meta, link, {
      ts: "1700.6",
      userId: "U999",
      userName: "Dana",
      text: "ship it",
      botUserId: "UBOT",
      deriveUserId: null,
    })
    expect(created).toBeTruthy()
    expect(created?.author_id).toBe("slack:U999")
    // The display name still comes from Slack, so the thread reads normally to a human — it is
    // the machine-readable attribution that stays honest.
    expect(created?.author).toBe("Dana")
  })

  it("dedupes a re-delivered Slack message ts", async () => {
    const { link } = await setup()
    const args = { ts: "1700.4", userId: "U1", userName: "X", text: "hi", botUserId: "UBOT" }
    expect(await ingestSlackReply(meta, link, args)).toBeTruthy()
    expect(await ingestSlackReply(meta, link, args)).toBe(null)
  })
})

// Regression: this called `openid.connect.userinfo` (all lowercase). Slack's Web API method
// names are case-sensitive, so it returned `unknown_method` and account linking failed for
// every user from the day it shipped — silently, because the authorize and token exchange both
// succeed and only this last hop dies. It went unnoticed because the route test's fetch stub
// matched the same lowercase typo. Verified against the live API: `userinfo` -> unknown_method,
// `userInfo` -> invalid_auth (the method exists, only the credential was rejected).
describe("slack OIDC userinfo", () => {
  it("calls Slack's camelCase openid.connect.userInfo, not the lowercase spelling", async () => {
    const seen: string[] = []
    const original = globalThis.fetch
    globalThis.fetch = (async (url: string | URL | Request) => {
      seen.push(String(url))
      return new Response(
        JSON.stringify({
          "https://slack.com/user_id": "U1",
          "https://slack.com/team_id": "T1",
          email: "a@b.c",
        }),
        { status: 200 },
      )
    }) as typeof fetch
    try {
      await slackOidcUserinfo("xoxp-test")
    } finally {
      globalThis.fetch = original
    }
    expect(seen).toHaveLength(1)
    expect(seen[0]).toContain("openid.connect.userInfo")
    expect(seen[0]).not.toContain("openid.connect.userinfo")
  })
})

// Two things can put a row in slack_user_link and they are not the same claim: `oauth` proves
// control of the Derive account, `email` only matched its address. Reading may rest on either —
// the address is one the workspace's own directory verified, and membership is checked anyway.
// Writing may not: an admin can set a Slack profile email through SCIM without the mailbox, and
// that must not become the power to settle a review or comment under somebody's name.
describe("slack identity: what a link proves", () => {
  const link = (origin: SlackUserLinkRecord["origin"]) => ({ origin }) as SlackUserLinkRecord

  describe("isVerifiedLink", () => {
    it("accepts only a deliberate sign-in", () => {
      expect(isVerifiedLink(link("oauth"))).toBe(true)
      expect(isVerifiedLink(link("email"))).toBe(false)
      // A miss never reaches the filtered accessor, but the predicate must not crown one if it did.
      expect(isVerifiedLink(link("miss"))).toBe(false)
      expect(isVerifiedLink(null)).toBe(false)
      expect(isVerifiedLink(undefined)).toBe(false)
    })
  })

  describe("chatSeatFor", () => {
    // The enforcement for the chat lane, and deliberately not a check: the tools take their
    // ceiling from the seat, so `publish` refuses a viewer on its own. Nothing has to remember to
    // ask, and no tool list can drift out of step.
    it("clamps an unverified asker to viewer, whatever their real seat", () => {
      for (const role of ["viewer", "commenter", "editor", "owner"] as Role[])
        expect(chatSeatFor(false, role)).toBe("viewer")
    })

    it("leaves a verified asker at their real seat", () => {
      for (const role of ["viewer", "commenter", "editor", "owner"] as Role[])
        expect(chatSeatFor(true, role)).toBe(role)
    })

    // Reading is the reason email identity exists — answering a question in Slack without a detour
    // through Settings. Clamping to `viewer` rather than refusing is what keeps that working.
    it("still leaves an unverified asker able to read", () => {
      expect(chatSeatFor(false, "owner")).toBe("viewer")
    })
  })
})

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
  it("treats absent or unreadable meta as NOT SEEN", () => {
    // Erring here costs one duplicate answer; the opposite error drops a real question on the
    // floor, so every ambiguous case has to mean "not seen".
    expect(parseSlackTs(null)).toBeNull()
    expect(parseSlackTs(undefined)).toBeNull()
    expect(parseSlackTs("{oops")).toBeNull()
    expect(parseSlackTs(JSON.stringify({ outcome: "answered" }))).toBeNull()
  })
})
