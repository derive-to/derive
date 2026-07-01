import { createHmac } from "node:crypto"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type ArtifactRecord, newId, type SlackThreadLinkRecord } from "@derive/core"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { describe, expect, it } from "vitest"
import { parseMeta } from "../src/lib/comments"
import { slackAuthorizeUrl, verifySlackSignature } from "../src/lib/slack"
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
      visibility: "link",
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

  it("dedupes a re-delivered Slack message ts", async () => {
    const { link } = await setup()
    const args = { ts: "1700.4", userId: "U1", userName: "X", text: "hi", botUserId: "UBOT" }
    expect(await ingestSlackReply(meta, link, args)).toBeTruthy()
    expect(await ingestSlackReply(meta, link, args)).toBe(null)
  })
})
