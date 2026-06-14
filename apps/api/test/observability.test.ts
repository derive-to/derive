import { join } from "node:path"
import { FsBlobStore } from "@dock/storage/fs"
import { describe, expect, it } from "vitest"
import { createApp } from "../src/app"
import { dir, meta } from "./helpers"

// Every response carries a request id (minted, or honoring a proxy's inbound one)
// so logs + clients can correlate a request end to end.
describe("observability: request id", () => {
  const app = createApp({
    meta,
    blobs: new FsBlobStore(join(dir, "blobs")),
    baseUrl: "http://dock.test",
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
