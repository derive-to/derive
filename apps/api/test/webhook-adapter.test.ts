import { createHmac } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type ArtifactRecord, type DeliveryRecord, newId } from "@derive/core"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { FsBlobStore } from "@derive/storage/fs"
import { afterAll, describe, expect, it, vi } from "vitest"
import { WebhookOutbox } from "../src/webhook-do"
import {
  type AddressGuard,
  deliverOnce,
  edgeGuard,
  enqueueForEvent,
  runDeliveryTick,
  standardWebhookSignature,
} from "../src/webhooks"
import { nodeDnsGuard } from "../src/webhooks-node"
import { ownerApp } from "./helpers"

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

  it("rejects an unparseable URL rather than throwing", async () => {
    expect(await edgeGuard.precheck("not a url")).toBe("invalid url")
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

  it("rejects an unparseable URL", async () => {
    expect(await nodeDnsGuard.precheck("http://")).toBe("invalid url")
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
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }))
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
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }))
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
  it("returns 0 when nothing is due", async () => {
    expect(await runDeliveryTick(meta, edgeGuard)).toBe(0)
  })

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

  it("returns 0 when no webhook subscribes", async () => {
    expect(await enqueueForEvent(meta, "http://h", artifact, "version.published", {})).toBe(0)
  })

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

describe("notify pokes the drainer only when something was enqueued", () => {
  it("pokes after a subscribed event fires, so delivery doesn't wait for the interval", async () => {
    const ndir = mkdtempSync(join(tmpdir(), "derive-whp-"))
    const m = new SqliteMetaStore(join(ndir, "derive.db"))
    const poke = vi.fn()
    const app = ownerApp({
      meta: m,
      blobs: new FsBlobStore(join(ndir, "blobs")),
      baseUrl: "http://derive.test",
      pokeWebhooks: poke,
    })
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
    expect(poke).not.toHaveBeenCalled() // registering a webhook isn't an event

    const form = new FormData()
    form.append("file", new Blob([new TextEncoder().encode("# a")]), "a.md")
    await app.request("/v1/artifacts", { method: "POST", body: form })
    // The publish enqueued a delivery, so the drainer was poked.
    await vi.waitFor(() => expect(poke).toHaveBeenCalled())

    m.close()
    rmSync(ndir, { recursive: true, force: true })
  })
})

describe("WebhookOutbox DO scheduling", () => {
  const fakeState = () => {
    let alarm: number | null = null
    return {
      get alarm() {
        return alarm
      },
      storage: {
        getAlarm: async () => alarm,
        setAlarm: async (t: number) => {
          alarm = t
        },
      },
    }
  }

  it("arms an alarm on the first poke and is idempotent while one is pending", async () => {
    const state = fakeState()
    // A dummy D1 is fine: fetch() only touches storage, never the store.
    const o = new WebhookOutbox(state as never, { DB: {} as never })
    expect(state.alarm).toBeNull()
    await o.fetch(new Request("https://outbox/poke", { method: "POST" }))
    const first = state.alarm
    expect(first).not.toBeNull()
    // A second poke while the alarm is still pending must not move it.
    await o.fetch(new Request("https://outbox/poke", { method: "POST" }))
    expect(state.alarm).toBe(first)
  })

  it("self-heals: reschedules an alarm when a tick throws", async () => {
    const state = fakeState()
    // env.DB rejects on use, so runDeliveryTick throws and the alarm() catch reschedules.
    const o = new WebhookOutbox(state as never, { DB: {} as never })
    await o.alarm()
    expect(state.alarm).not.toBeNull()
  })
})
