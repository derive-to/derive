import { join } from "node:path"
import { FsBlobStore } from "@derive/storage/fs"
import { describe, expect, it } from "vitest"
import { createApp } from "../src/app"
import { redactPath } from "../src/lib/observability"
import { dir, meta } from "./helpers"

// /healthz is liveness (process up); /readyz is readiness (the DB + blob backend
// are actually reachable), so an orchestrator can gate traffic on dependencies.
describe("health + readiness endpoints", () => {
  const blobs = new FsBlobStore(join(dir, "blobs"))

  it("/readyz returns 200 when the datastore + blob store are reachable", async () => {
    const app = createApp({ meta, blobs, baseUrl: "http://derive.test" })
    const r = await app.request("/readyz")
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ok: true })
  })

  it("/readyz returns 503 when the datastore is unreachable", async () => {
    const broken = new Proxy(meta, {
      get: (t, p) =>
        p === "getWorkspace" ? () => Promise.reject(new Error("db down")) : Reflect.get(t, p),
    })
    const app = createApp({ meta: broken, blobs, baseUrl: "http://derive.test" })
    expect((await app.request("/readyz")).status).toBe(503)
  })

  it("/readyz returns 503 when the blob store is unreachable", async () => {
    // The probe must do real blob I/O: it reads with a valid 64-hex sentinel key
    // (a non-hex key short-circuits to null without touching the backend), so a
    // store whose backend is down throws and the check fails. This guards against
    // the probe silently regressing back into a no-op.
    const brokenBlobs = new Proxy(blobs, {
      get: (t, p) =>
        p === "get" ? () => Promise.reject(new Error("blob backend down")) : Reflect.get(t, p),
    })
    const app = createApp({ meta, blobs: brokenBlobs, baseUrl: "http://derive.test" })
    expect((await app.request("/readyz")).status).toBe(503)
  })
})

// ---------------------------------------------------------------------------
// Access-log redaction: token-shaped path segments never reach the log.
describe("access log redaction", () => {
  // Invite tokens ride URL paths and the DB stores only their hash — the access
  // log must not undo that by recording the raw path. Pins the redaction for
  // every token prefix in circulation (dki_ workspace, dka_ artifact, dk_agt_).
  it("token-shaped path segments never reach the log", () => {
    const t = "a".repeat(64)
    expect(redactPath(`/v1/artifact-invites/dka_${t}`)).toBe("/v1/artifact-invites/dka_[redacted]")
    expect(redactPath(`/v1/artifact-invites/dka_${t}/accept`)).toBe(
      "/v1/artifact-invites/dka_[redacted]/accept",
    )
    expect(redactPath(`/v1/invites/dki_${t}/accept`)).toBe("/v1/invites/dki_[redacted]/accept")
    expect(redactPath(`/x/dk_agt_${t}`)).toBe("/x/dk_agt_[redacted]")
    // Ordinary paths pass through untouched.
    expect(redactPath("/v1/artifacts/abc123/members")).toBe("/v1/artifacts/abc123/members")
  })
})

// ---------------------------------------------------------------------------
// Request ids: every response carries one, and an inbound proxy id is honoured.
describe("observability: request id", () => {
  // Every response carries a request id (minted, or honoring a proxy's inbound one)
  // so logs + clients can correlate a request end to end.
  const app = createApp({
    meta,
    blobs: new FsBlobStore(join(dir, "blobs")),
    baseUrl: "http://derive.test",
  })

  it("stamps every response with an X-Request-Id", async () => {
    const id = (await app.request("/healthz")).headers.get("x-request-id")
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it("honors an inbound X-Request-Id (proxy / load-balancer correlation)", async () => {
    const r = await app.request("/healthz", { headers: { "x-request-id": "trace-abc-123" } })
    expect(r.headers.get("x-request-id")).toBe("trace-abc-123")
  })
})
