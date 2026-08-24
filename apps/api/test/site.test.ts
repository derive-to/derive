import { join } from "node:path"
import { FsBlobStore } from "@derive/storage/fs"
import { describe, expect, it } from "vitest"
import { createApp } from "../src/app"
import { dir, meta } from "./helpers"

const SHELL =
  "<!doctype html><html><head><title>Derive</title></head><body><div id=root></div></body></html>"

// Worker-shaped deps: no serveWeb (assets come from the platform binding), the shell
// arrives via the async provider, the public site over `deps.site` (the SITE service
// binding in production). `/` is routed worker-first there, so the app MUST answer it.
const workerApp = (site?: (req: Request) => Promise<Response>) =>
  createApp({
    meta,
    blobs: new FsBlobStore(join(dir, "blobs-site")),
    baseUrl: "http://derive.test",
    token: "tok",
    shellFetch: async () => SHELL,
    site,
  })

const SITE = async (req: Request): Promise<Response> => {
  const path = new URL(req.url).pathname
  if (path === "/")
    return new Response("SITE HOME", {
      headers: { "Content-Type": "text/html", "Cache-Control": "public, max-age=300" },
    })
  return new Response("SITE 404", { status: 404 })
}

describe("the front door (worker-first `/` and `/robots.txt`)", () => {
  it("serves the site's landing page to anonymous visitors, never shared-cacheable", async () => {
    const res = await workerApp(SITE).request("/")
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("SITE HOME")
    // The site said public; the app must override — the same URL serves the SPA
    // to signed-in visitors, and a cached brochure would shadow the app after login.
    expect(res.headers.get("cache-control")).toBe("private, max-age=0, must-revalidate")
  })

  it("serves the SPA shell to visitors with a session cookie", async () => {
    const app = workerApp(SITE)
    for (const name of ["better-auth.session_token", "__Secure-better-auth.session_token"]) {
      const res = await app.request("/", { headers: { cookie: `${name}=abc` } })
      expect(res.status).toBe(200)
      expect(await res.text()).toContain("id=root")
    }
  })

  it("shows the landing page to a signed-in visitor who asks with ?home", async () => {
    const app = workerApp(SITE)
    const res = await app.request("/?home", {
      headers: { cookie: "better-auth.session_token=abc" },
    })
    expect(await res.text()).toBe("SITE HOME")
    expect(res.headers.get("cache-control")).toBe("private, max-age=0, must-revalidate")
  })

  it("serves the SPA shell on the app.* alias host", async () => {
    const res = await workerApp(SITE).request("/", { headers: { host: "app.derive.test" } })
    expect(await res.text()).toContain("id=root")
  })

  it("falls back to the shell when the site answers `/` with anything but a page", async () => {
    const broken = async () => new Response("nope", { status: 404 })
    const res = await workerApp(broken).request("/")
    expect(res.status).toBe(200)
    expect(await res.text()).toContain("id=root")
  })

  it("falls back to the shell when no site is bound (worker-first `/` must not 404)", async () => {
    const res = await workerApp(undefined).request("/")
    expect(res.status).toBe(200)
    expect(await res.text()).toContain("id=root")
  })

  it("never serves the API-origin placeholder when a shell exists (the launch-day bug)", async () => {
    // Regression: system.ts's placeholder `/` used to register whenever serveWeb was
    // off — which is the Worker's shape — and, mounted first, shadowed both the
    // site's page and the signed-in shell once `/` went worker-first.
    const app = workerApp(SITE)
    for (const headers of [{}, { cookie: "better-auth.session_token=abc" }] as Record<
      string,
      string
    >[]) {
      const html = await (await app.request("/", { headers })).text()
      expect(html).not.toContain("derive publish ./your-thing")
    }
  })

  it("writes the Sitemap line into robots.txt only where a site exists", async () => {
    const hosted = await (await workerApp(SITE).request("/robots.txt")).text()
    expect(hosted).toContain("Disallow: /settings/")
    expect(hosted).toContain("Sitemap: http://derive.test/sitemap.xml")

    const selfHost = await (await workerApp(undefined).request("/robots.txt")).text()
    expect(selfHost).toContain("Disallow: /v1/")
    expect(selfHost).not.toContain("Sitemap:")
  })
})
