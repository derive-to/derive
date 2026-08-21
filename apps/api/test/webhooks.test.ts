import { createHmac } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type ArtifactRecord, type DeliveryRecord, newId } from "@derive/core"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { FsBlobStore } from "@derive/storage/fs"
import { afterAll, describe, expect, it, vi } from "vitest"
import {
  type AddressGuard,
  buildPayload,
  deliverOnce,
  edgeGuard,
  enqueueForEvent,
  runDeliveryTick,
  sign,
  slackMessage,
  standardWebhookSignature,
} from "../src/webhooks"
import { nodeDnsGuard } from "../src/webhooks-node"
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

// ---------------------------------------------------------------------------
// The delivery adapter under the outbox: the SSRF address guards (literal, hex- and
// integer-encoded loopback, cloud metadata) run BEFORE any fetch, and generic hooks carry
// Standard Webhooks signatures alongside the legacy header.
describe("webhook delivery adapter", () => {
  // A guard that always allows: lets a delivery reach the fetch without DNS/egress
  // checks, so we can prove the guard runs BEFORE the request (and that an allowed URL
  // gets past it). Pointed only at a refused localhost port — never the network.
  const allowAll: AddressGuard = {
    async precheck() {
      return null
    },
  }

  const makeDelivery = (over: Partial<DeliveryRecord> = {}): DeliveryRecord => ({
    id: "wd_test",
    webhook_id: "wh_test",
    url: "http://example.com/hook",
    secret: "s",
    kind: "generic",
    event_type: "version.published",
    payload: JSON.stringify({
      event: "version.published",
      at: "2026-01-01T00:00:00Z",
      artifact: { short_id: "sample00", title: "Spec", url: "http://h/artifacts/sample00" },
      data: { version: 1 },
    }),
    status: "pending",
    attempts: 0,
    last_error: null,
    next_attempt_at: "2026-01-01T00:00:00Z",
    created_at: "2026-01-01T00:00:00Z",
    ...over,
  })

  describe("edgeGuard (Workers / DO: no DNS, trust egress isolation)", () => {
    it("blocks literal private / loopback / link-local / metadata addresses", async () => {
      for (const host of [
        "http://127.0.0.1/h",
        "http://localhost/h",
        "http://10.0.0.5/h",
        "http://192.168.1.1/h",
        "http://169.254.169.254/latest/meta-data", // cloud metadata
        "http://[::1]/h",
        "http://0x7f000001/h", // hex-encoded 127.0.0.1
        "http://2130706433/h", // integer-encoded 127.0.0.1
      ]) {
        expect(await edgeGuard.precheck(host), host).toMatch(/private address/)
      }
    })

    it("allows ordinary public hostnames (DNS rebinding is caught by CF egress, not here)", async () => {
      expect(await edgeGuard.precheck("https://hooks.example.com/x")).toBeNull()
      expect(await edgeGuard.precheck("https://discord.com/api/webhooks/1/abc")).toBeNull()
    })
  })

  describe("nodeDnsGuard (Node: resolve + reject private addresses)", () => {
    // Literal IPs and localhost resolve without touching the network, so these stay
    // deterministic. The public-host allow path needs real DNS and is left to the edge
    // guard's allow test + integration.
    it("blocks a hostname that resolves into private space", async () => {
      expect(await nodeDnsGuard.precheck("http://127.0.0.1/h")).toMatch(/private address/)
      expect(await nodeDnsGuard.precheck("http://localhost/h")).toMatch(/private address/)
      expect(await nodeDnsGuard.precheck("http://10.0.0.1/h")).toMatch(/private address/)
    })
  })

  describe("deliverOnce honors the injected guard", () => {
    it("never fetches when the guard blocks (returns the guard's status)", async () => {
      const spy = vi.spyOn(globalThis, "fetch")
      const blocking: AddressGuard = {
        async precheck() {
          return "blocked: nope"
        },
      }
      const r = await deliverOnce(makeDelivery(), blocking)
      expect(r).toEqual({ ok: false, status: "blocked: nope" })
      expect(spy).not.toHaveBeenCalled()
      spy.mockRestore()
    })

    it("gets past an allowing guard to the request (failure is the fetch, not the guard)", async () => {
      // A refused localhost port: the guard allowed it, so we reach fetch and fail there
      // with a connection error — proving the guard ran first and let it through.
      const r = await deliverOnce(makeDelivery({ url: "http://127.0.0.1:1/hook" }), allowAll)
      expect(r.ok).toBe(false)
      expect(r.status).not.toMatch(/private address/)
    })
  })

  describe("Standard Webhooks signing", () => {
    it("produces a v1 base64 signature over {id}.{timestamp}.{body} a library can verify", () => {
      const sig = standardWebhookSignature("whsec_c2VjcmV0", "wd_1", "1700000000", "{}")
      expect(sig).toMatch(/^v1,[A-Za-z0-9+/]+=*$/)
      // Independently reproduce it the way the standardwebhooks verifier does: strip the
      // whsec_ prefix, base64-decode the key, HMAC the signed content, base64 the digest.
      const key = Buffer.from("c2VjcmV0", "base64")
      const expected = createHmac("sha256", key).update("wd_1.1700000000.{}").digest("base64")
      expect(sig).toBe(`v1,${expected}`)
    })

    it("changes when the id, timestamp, or body changes (no replay across deliveries)", () => {
      const base = standardWebhookSignature("s", "wd_1", "1700000000", "{}")
      expect(standardWebhookSignature("s", "wd_2", "1700000000", "{}")).not.toBe(base)
      expect(standardWebhookSignature("s", "wd_1", "1700000001", "{}")).not.toBe(base)
      expect(standardWebhookSignature("s", "wd_1", "1700000000", '{"x":1}')).not.toBe(base)
    })

    it("sends both Standard Webhooks headers and the legacy header for a generic hook", async () => {
      const spy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response("ok", { status: 200 }))
      const r = await deliverOnce(makeDelivery({ url: "https://hooks.example.com/x" }), allowAll)
      expect(r.ok).toBe(true)
      const headers = (spy.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>
      const ts = headers["webhook-timestamp"] ?? ""
      expect(headers["webhook-id"]).toBe("wd_test")
      expect(ts).toMatch(/^\d+$/)
      expect(headers["webhook-signature"]).toMatch(/^v1,/)
      expect(headers["x-derive-signature"]).toMatch(/^sha256=/) // legacy still present
      // The signature is over the id/timestamp it actually sent.
      const body = spy.mock.calls[0]?.[1]?.body as string
      expect(headers["webhook-signature"]).toBe(standardWebhookSignature("s", "wd_test", ts, body))
      spy.mockRestore()
    })

    it("does not sign Slack messages (Slack uses its own incoming-webhook URL secret)", async () => {
      const spy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response("ok", { status: 200 }))
      await deliverOnce(
        makeDelivery({ kind: "slack", url: "https://hooks.slack.com/services/x" }),
        allowAll,
      )
      const headers = (spy.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>
      expect(headers["webhook-signature"]).toBeUndefined()
      expect(headers["x-derive-signature"]).toBeUndefined()
      spy.mockRestore()
    })
  })

  const dir = mkdtempSync(join(tmpdir(), "derive-wha-"))
  const meta = new SqliteMetaStore(join(dir, "derive.db"))
  afterAll(() => {
    meta.close()
    rmSync(dir, { recursive: true, force: true })
  })

  describe("runDeliveryTick returns the claimed count + records results", () => {
    it("counts claimed rows and reschedules a blocked one for retry", async () => {
      const id = newId("whd")
      await meta.enqueueDelivery({
        id,
        webhook_id: "wh_test",
        url: "http://10.0.0.1/hook", // edgeGuard blocks it: a deterministic delivery failure
        secret: "s",
        kind: "generic",
        event_type: "version.published",
        payload: "{}",
      })
      const claimed = await runDeliveryTick(meta, edgeGuard)
      expect(claimed).toBe(1)
      const [row] = await meta.recentDeliveries("wh_test", 5)
      expect(row?.id).toBe(id)
      expect(row?.status).toBe("pending") // failed -> retry, not dead (attempt 1 of 6)
      expect(row?.attempts).toBe(1)
      expect(row?.last_error).toMatch(/private address/)
      expect(new Date(row?.next_attempt_at ?? 0).getTime()).toBeGreaterThan(Date.now())
    })
  })

  describe("enqueueForEvent reports how many deliveries it queued", () => {
    const artifact = {
      id: "a_e",
      short_id: "ev000000",
      org_id: "default",
      title: "E",
    } as ArtifactRecord

    it("returns the count when webhooks subscribe (so the caller can skip an idle poke)", async () => {
      // Org-scoped (artifact_id null) so they match any artifact in the org without an
      // artifact row to satisfy the FK — enqueueForEvent only queries the webhook table.
      await meta.createWebhook({
        id: newId("wh"),
        org_id: "default",
        artifact_id: null,
        url: "http://example.com/a",
        secret: "s",
        kind: "generic",
        events: "version.published",
      })
      await meta.createWebhook({
        id: newId("wh"),
        org_id: "default",
        artifact_id: null,
        url: "http://example.com/b",
        secret: "s",
        kind: "generic",
        events: "*",
      })
      expect(await enqueueForEvent(meta, "http://h", artifact, "version.published", {})).toBe(2)
      // A non-subscribed event only reaches the "*" hook.
      expect(await enqueueForEvent(meta, "http://h", artifact, "comment.created", {})).toBe(1)
    })
  })
})
