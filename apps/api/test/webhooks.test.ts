import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type ArtifactRecord, newId } from "@derive/core"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { FsBlobStore } from "@derive/storage/fs"
import { afterAll, describe, expect, it } from "vitest"
import { buildPayload, sign, slackMessage, WEBHOOK_EVENTS } from "../src/webhooks"
import { ownerApp } from "./helpers"

const sampleArtifact = {
  id: "a1",
  short_id: "sample00",
  title: "Spec",
} as ArtifactRecord

describe("webhook formatting + signing", () => {
  it("signs the body with HMAC-SHA256 and a stable header shape", () => {
    const s = sign("secret", '{"a":1}')
    expect(s).toMatch(/^sha256=[0-9a-f]{64}$/)
    expect(sign("secret", '{"a":1}')).toBe(s) // deterministic
    expect(sign("other", '{"a":1}')).not.toBe(s) // key matters
  })

  it("builds a normalized payload", () => {
    const p = buildPayload("http://h", sampleArtifact, "comment.created", { author: "ann" })
    expect(p.event).toBe("comment.created")
    // The URL is now name-first (slug from the title) + short id.
    expect(p.artifact).toEqual({
      short_id: "sample00",
      title: "Spec",
      url: "http://h/artifacts/spec-sample00",
    })
    expect(p.data.author).toBe("ann")
  })

  it("formats Slack messages per event type", () => {
    const comment = slackMessage(
      buildPayload("http://h", sampleArtifact, "comment.created", { author: "ann", body: "nice" }),
    ) as { text: string }
    expect(comment.text).toContain(":speech_balloon:")
    expect(comment.text).toContain("ann")
    const published = slackMessage(
      buildPayload("http://h", sampleArtifact, "version.published", { version: 3 }),
    ) as { text: string }
    expect(published.text).toContain(":package:")
    expect(published.text).toContain("v3")
  })

  // The incoming-webhook path (Settings -> Webhooks -> "Slack") builds mrkdwn from the same
  // untrusted fields the connected app does, but was never given the connected app's escaping.
  // An artifact title or comment body could therefore reach `<!channel>` and ping the whole
  // channel, or forge `<url|label>` as a link the reader can't distinguish from a real one.
  it("neutralizes Slack control syntax in every untrusted field", () => {
    const hostile = { id: "a1", short_id: "s0", title: "<!channel> ship it" } as ArtifactRecord
    const m = slackMessage(
      buildPayload("http://h", hostile, "comment.created", {
        author: "<@U999>",
        body: "click <https://evil.example|Derive Support> now",
        quote: "<!here>",
      }),
    ) as { text: string; blocks: unknown[] }
    const all = JSON.stringify(m)
    expect(all).not.toContain("<!channel>")
    expect(all).not.toContain("<!here>")
    expect(all).not.toContain("<@U999>")
    expect(all).not.toContain("<https://evil.example|Derive Support>")
    expect(all).toContain("&lt;!channel&gt;")
    // The artifact URL is ours and must stay a working link — and `artifactUrl` slugifies the
    // title, so a hostile title can't smuggle a `<`/`>`/`|` into the URL half of the wrapper.
    expect(all).toContain("<http://h/artifacts/")
    expect(m.blocks).toHaveLength(2)
  })

  it("escapes the mentioned-user list and renders a body's real markdown", () => {
    const m = slackMessage(
      buildPayload("http://h", sampleArtifact, "comment.mention", {
        author: "ann",
        mentioned: ["<!channel>", "bob"],
        body: "see [the spec](https://ok.example/a?b=1&c=2)",
      }),
    ) as { text: string; blocks: unknown[] }
    const all = JSON.stringify(m)
    expect(all).not.toContain("<!channel>")
    // A real markdown link renders, with its query string byte-intact.
    expect(all).toContain("<https://ok.example/a?b=1&c=2|the spec>")
  })
})

const dir = mkdtempSync(join(tmpdir(), "derive-wh-"))
const meta = new SqliteMetaStore(join(dir, "derive.db"))
const app = ownerApp({
  meta,
  blobs: new FsBlobStore(join(dir, "blobs")),
  baseUrl: "http://derive.test",
})
afterAll(() => {
  meta.close()
  rmSync(dir, { recursive: true, force: true })
})

describe("webhook outbox", () => {
  it("enqueues a delivery when a subscribed event fires", async () => {
    await app.request("/v1/webhooks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: "http://example.com/hook",
        kind: "generic",
        secret: "s",
        events: ["version.published"],
      }),
    })

    // each publish (the new artifact + the republish) fires version.published
    const form = new FormData()
    form.append("file", new Blob([new TextEncoder().encode("# a")]), "a.md")
    const { short_id } = await (
      await app.request("/v1/artifacts", { method: "POST", body: form })
    ).json()
    const f2 = new FormData()
    f2.append("file", new Blob([new TextEncoder().encode("# a2")]), "a.md")
    f2.append("message", "v2")
    await app.request(`/v1/artifacts/${short_id}/versions`, { method: "POST", body: f2 })

    const due = await meta.claimDueDeliveries(
      new Date(Date.now() + 1000).toISOString(),
      10,
      new Date(Date.now() + 60_000).toISOString(),
    )
    const forThis = due.filter((d) => JSON.parse(d.payload).artifact.short_id === short_id)
    expect(forThis.length).toBe(2)
    expect(forThis.every((d) => d.event_type === "version.published")).toBe(true)
    expect(forThis[0]?.url).toBe("http://example.com/hook")
    expect(JSON.parse(forThis[1]?.payload ?? "{}").data.version).toBe(2)
  })

  it("hides the secret in the API response", async () => {
    const list = await (await app.request("/v1/webhooks")).json()
    expect(list.webhooks.length).toBeGreaterThan(0)
    expect(list.webhooks[0].secret).toBeUndefined()
  })

  // The picker used to carry its own copy of this list, three entries against the server's
  // eleven, so eight events could not be chosen from Settings at all. The list ships with the
  // response now, which is the only arrangement that cannot drift.
  it("ships the event vocabulary with the list", async () => {
    const list = await (await app.request("/v1/webhooks")).json()
    expect(list.event_options).toEqual([...WEBHOOK_EVENTS])
    expect(list.event_options).toContain("review.sent_back")
    expect(list.event_options.length).toBeGreaterThan(3)
  })
})

// A fresh store so the only due rows are the ones this test enqueues. The claim is
// what stops the outbox double-delivering under multi-instance Postgres; on SQLite
// (single-writer) the same lease+increment logic prevents overlapping-tick dupes.
describe("webhook outbox: atomic claim", () => {
  const cdir = mkdtempSync(join(tmpdir(), "derive-whc-"))
  const m = new SqliteMetaStore(join(cdir, "derive.db"))
  afterAll(() => {
    m.close()
    rmSync(cdir, { recursive: true, force: true })
  })

  it("hands each due delivery to exactly one claimer, counts an attempt, and leases it", async () => {
    const ids: string[] = []
    for (let i = 0; i < 6; i++) {
      const id = newId("whd")
      ids.push(id)
      await m.enqueueDelivery({
        id,
        webhook_id: "wh_test",
        url: "http://example.com/hook",
        secret: "s",
        kind: "generic",
        event_type: "version.published",
        payload: "{}",
      })
    }
    const now = new Date(Date.now() + 1000).toISOString()
    const lease = new Date(Date.now() + 60_000).toISOString()
    // Two competing claimers; together they should partition the 6 due rows.
    const [a, b] = await Promise.all([
      m.claimDueDeliveries(now, 4, lease),
      m.claimDueDeliveries(now, 4, lease),
    ])
    const claimedIds = [...a, ...b].map((d) => d.id)
    expect([...claimedIds].sort()).toEqual([...ids].sort()) // all 6, exactly once
    expect(new Set(claimedIds).size).toBe(6) // none claimed twice
    for (const d of [...a, ...b]) {
      expect(d.attempts).toBe(1) // the claim counts an attempt
      expect(d.next_attempt_at).toBe(lease) // and leases the row forward
    }
    // A re-claim at the same instant finds nothing — every row is leased forward.
    expect(await m.claimDueDeliveries(now, 50, lease)).toHaveLength(0)
  })
})
