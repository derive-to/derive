import { createHmac } from "node:crypto"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type ArtifactRecord, newId, type SlackThreadLinkRecord } from "@derive/core"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { describe, expect, it } from "vitest"
import { parseMeta } from "../src/lib/comments"
import { slackAuthorizeUrl, slackOidcUserinfo, verifySlackSignature } from "../src/lib/slack"
import { ingestSlackReply } from "../src/lib/slack-comments"

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

describe("slack authorize url", () => {
  it("requests the bot scopes needed for posting + reply-back", () => {
    const u = new URL(slackAuthorizeUrl("cid", "https://derive.test/cb", "state123"))
    expect(u.searchParams.get("client_id")).toBe("cid")
    expect(u.searchParams.get("state")).toBe("state123")
    expect(u.searchParams.get("scope")).toContain("chat:write")
    expect(u.searchParams.get("scope")).toContain("channels:history")
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
