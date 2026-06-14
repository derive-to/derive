import { join } from "node:path"
import { FsBlobStore } from "@dock/storage/fs"
import { describe, expect, it } from "vitest"
import { createApp } from "../src/app"
import { dir, meta } from "./helpers"

// /healthz is liveness (process up); /readyz is readiness (the DB + blob backend
// are actually reachable), so an orchestrator can gate traffic on dependencies.
describe("health + readiness endpoints", () => {
  const blobs = new FsBlobStore(join(dir, "blobs"))

  it("/healthz is a pure liveness check (200, no dependency probe)", async () => {
    const app = createApp({ meta, blobs, baseUrl: "http://dock.test" })
    expect((await app.request("/healthz")).status).toBe(200)
  })

  it("/readyz returns 200 when the datastore + blob store are reachable", async () => {
    const app = createApp({ meta, blobs, baseUrl: "http://dock.test" })
    const r = await app.request("/readyz")
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ok: true })
  })

  it("/readyz returns 503 when the datastore is unreachable", async () => {
    const broken = new Proxy(meta, {
      get: (t, p) =>
        p === "getWorkspace" ? () => Promise.reject(new Error("db down")) : Reflect.get(t, p),
    })
    const app = createApp({ meta: broken, blobs, baseUrl: "http://dock.test" })
    expect((await app.request("/readyz")).status).toBe(503)
  })
})
