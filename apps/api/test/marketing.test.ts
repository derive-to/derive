import { join } from "node:path"
import { FsBlobStore } from "@derive/storage/fs"
import { describe, expect, it } from "vitest"
import { createApp } from "../src/app"
import { dir, meta } from "./helpers"

const SHELL =
  "<!doctype html><html><head><title>Derive</title></head><body><div id=root></div></body></html>"
const HOME = "<!doctype html><html><body>MARKETING HOME</body></html>"
const PRICING = "<!doctype html><html><body>MARKETING PRICING</body></html>"
const PRIVACY = "<!doctype html><html><body>MARKETING PRIVACY</body></html>"

// Worker-shaped deps: no serveWeb (assets come from the platform binding), the shell
// arrives via the async provider. `/`, `/pricing`, and `/privacy` are routed
// worker-first there (wrangler.toml run_worker_first), so the app itself MUST
// answer them.
const workerApp = (marketing?: {
  home: () => Promise<string | null>
  pricing: () => Promise<string | null>
  privacy: () => Promise<string | null>
}) =>
  createApp({
    meta,
    blobs: new FsBlobStore(join(dir, "blobs-marketing")),
    baseUrl: "http://derive.test",
    token: "tok",
    shellFetch: async () => SHELL,
    marketing,
  })

const MARKETING = {
  home: async () => HOME,
  pricing: async () => PRICING,
  privacy: async () => PRIVACY,
}

describe("marketing front door (worker-first `/`, `/pricing`, and `/privacy`)", () => {
  it("serves the marketing page to anonymous visitors, never shared-cacheable", async () => {
    const a = workerApp(MARKETING)
    const res = await a.request("/")
    expect(res.status).toBe(200)
    expect(await res.text()).toContain("MARKETING HOME")
    expect(res.headers.get("cache-control")).toContain("private")
  })

  it("serves the SPA shell to visitors with a session cookie", async () => {
    const a = workerApp(MARKETING)
    for (const name of ["better-auth.session_token", "__Secure-better-auth.session_token"]) {
      const res = await a.request("/", { headers: { cookie: `${name}=abc` } })
      expect(res.status).toBe(200)
      expect(await res.text()).toContain("id=root")
    }
  })

  it("serves the SPA shell on the app.* alias host", async () => {
    const a = workerApp(MARKETING)
    const res = await a.request("/", { headers: { host: "app.derive.test" } })
    expect(await res.text()).toContain("id=root")
  })

  it("serves the pricing page to everyone, shared-cacheable", async () => {
    const a = workerApp(MARKETING)
    const res = await a.request("/pricing", {
      headers: { cookie: "better-auth.session_token=abc" },
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain("MARKETING PRICING")
    expect(res.headers.get("cache-control")).toContain("public")
  })

  it("serves the privacy page to everyone, shared-cacheable", async () => {
    const a = workerApp(MARKETING)
    const res = await a.request("/privacy", {
      headers: { cookie: "better-auth.session_token=abc" },
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain("MARKETING PRIVACY")
    expect(res.headers.get("cache-control")).toContain("public")
  })

  it("never serves the API-origin placeholder when a shell exists (the launch-day bug)", async () => {
    // Regression: system.ts's placeholder `/` used to register whenever serveWeb was
    // off — which is the Worker's shape — and, mounted first, shadowed both the
    // marketing page and the signed-in shell once `/` went worker-first.
    const a = workerApp(MARKETING)
    for (const headers of [{}, { cookie: "better-auth.session_token=abc" }] as Record<
      string,
      string
    >[]) {
      const html = await (await a.request("/", { headers })).text()
      expect(html).not.toContain("An open home for AI-generated artifacts")
    }
  })

  it("falls back to the SPA shell when marketing is off (worker-first paths must not 404)", async () => {
    const a = workerApp(undefined)
    for (const path of ["/", "/pricing", "/privacy"]) {
      const res = await a.request(path)
      expect(res.status).toBe(200)
      expect(await res.text()).toContain("id=root")
    }
  })

  it("keeps the API-origin placeholder for deployments with no SPA at all", async () => {
    const a = createApp({
      meta,
      blobs: new FsBlobStore(join(dir, "blobs-marketing-bare")),
      baseUrl: "http://derive.test",
      token: "tok",
    })
    const res = await a.request("/")
    expect(res.status).toBe(200)
    expect(await res.text()).toContain("An open home for AI-generated artifacts")
  })

  it("falls back to the shell when a marketing page is missing from the build", async () => {
    const a = workerApp({
      home: async () => null,
      pricing: async () => null,
      privacy: async () => null,
    })
    const res = await a.request("/")
    expect(res.status).toBe(200)
    expect(await res.text()).toContain("id=root")
  })
})
