import { join } from "node:path"
import { FsBlobStore } from "@derive/storage/fs"
import { describe, expect, it } from "vitest"
import { createApp } from "../src/app"
import { dir, meta } from "./helpers"

// The hosted landing page for `derive login` (the native/CLI OAuth flow). It must
// answer from the Worker with the one-time code on success and a readable failure
// otherwise — never a blank page or a localhost bounce.
describe("GET /oauth/cli-callback", () => {
  const blobs = new FsBlobStore(join(dir, "blobs"))
  const app = createApp({ meta, blobs, baseUrl: "http://derive.test" })

  it("shows the authorization code for copy-paste back to the terminal", async () => {
    const r = await app.request("/oauth/cli-callback?code=ABC123XYZ&state=s")
    expect(r.status).toBe(200)
    expect(r.headers.get("content-type")).toContain("text/html")
    const html = await r.text()
    expect(html).toContain("ABC123XYZ")
    expect(html).toContain("paste it back into your terminal")
  })

  it("renders the error (and no code) when authorization fails", async () => {
    const r = await app.request(
      "/oauth/cli-callback?error=access_denied&error_description=You%20declined",
    )
    expect(r.status).toBe(200)
    const html = await r.text()
    expect(html).toContain("You declined")
    expect(html).toContain("didn't complete")
  })

  it("handles a missing code without crashing", async () => {
    const r = await app.request("/oauth/cli-callback")
    expect(r.status).toBe(200)
    expect(await r.text()).toContain("didn't complete")
  })
})
