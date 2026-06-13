import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ArtifactRecord } from "@dock/core"
import { SqliteMetaStore } from "@dock/db/sqlite"
import { FsBlobStore } from "@dock/storage/fs"
import { afterAll, describe, expect, it } from "vitest"
import { createApp } from "../src/app"
import { buildPayload, sign, slackMessage } from "../src/webhooks"

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
    expect(p.artifact).toEqual({ short_id: "sample00", title: "Spec", url: "http://h/a/sample00" })
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
})

const dir = mkdtempSync(join(tmpdir(), "dock-wh-"))
const meta = new SqliteMetaStore(join(dir, "dock.db"))
const app = createApp({
  meta,
  blobs: new FsBlobStore(join(dir, "blobs")),
  baseUrl: "http://dock.test",
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

    const due = await meta.claimDueDeliveries(new Date(Date.now() + 1000).toISOString(), 10)
    const forThis = due.filter((d) => JSON.parse(d.payload).artifact.short_id === short_id)
    expect(forThis.length).toBe(2)
    expect(forThis.every((d) => d.event_type === "version.published")).toBe(true)
    expect(forThis[0].url).toBe("http://example.com/hook")
    expect(JSON.parse(forThis[1].payload).data.version).toBe(2)
  })

  it("hides the secret in the API response", async () => {
    const list = await (await app.request("/v1/webhooks")).json()
    expect(list.webhooks.length).toBeGreaterThan(0)
    expect(list.webhooks[0].secret).toBeUndefined()
  })
})
