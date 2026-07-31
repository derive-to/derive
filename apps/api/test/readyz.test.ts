import { join } from "node:path"
import { FsBlobStore } from "@derive/storage/fs"
import { describe, expect, it } from "vitest"
import { createApp } from "../src/app"
import { dir, meta } from "./helpers"

// /healthz is liveness (process up); /readyz is readiness (the DB + blob backend
// are actually reachable), so an orchestrator can gate traffic on dependencies.
describe("health + readiness endpoints", () => {
  const blobs = new FsBlobStore(join(dir, "blobs"))

  it("/healthz is a pure liveness check (200, no dependency probe)", async () => {
    const app = createApp({ meta, blobs, baseUrl: "http://derive.test" })
    expect((await app.request("/healthz")).status).toBe(200)
  })

  // The version marker. A deploy can fail, or be skipped, while the pipeline around it reads
  // green — and liveness alone cannot tell a fresh worker from the one already serving. This is
  // what makes "did my change actually ship" answerable with curl, by anyone, with no CI or
  // Cloudflare access.
  it("/healthz reports the build it is serving", async () => {
    const app = createApp({ meta, blobs, baseUrl: "http://derive.test", buildId: "abc1234" })
    expect(await (await app.request("/healthz")).json()).toEqual({ ok: true, build: "abc1234" })
  })

  // "dev" rather than omitting the field: a consumer comparing builds gets a value that can
  // never equal a commit sha, instead of `undefined` that could read as "matches".
  it("says dev when no build was stamped, never nothing", async () => {
    const app = createApp({ meta, blobs, baseUrl: "http://derive.test" })
    expect(await (await app.request("/healthz")).json()).toEqual({ ok: true, build: "dev" })
  })

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
