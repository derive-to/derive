import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Hono } from "hono"
import { describe, expect, it } from "vitest"
import { API_PATHS, isApiPath, mountWeb } from "../src/lib/serve-web"
import { isServerRenderedPath, isSpaPath, isStaticRootPath } from "../src/lib/spa-paths"

const apiDir = join(import.meta.dirname, "..")

// Mirror node.ts: a real API route, then the bundled-SPA serving on top. (Asset
// streaming + the immutable cache header are @hono/node-server's serveStatic over
// the real node server; node.ts wires them unchanged, so they aren't re-asserted
// here — this exercises the path contract that keeps the two modes consistent.)
const makeApp = (shell = "<!doctype html><div id=app></div>") => {
  const app = new Hono()
  app.get("/v1/ping", (c) => c.json({ ok: true }))
  mountWeb(app, { webRoot: ".", shellHtml: shell })
  return app
}

const quoted = (s: string) => [...s.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? "")

describe("serve-web: SPA vs API path contract", () => {
  it("classifies server-owned vs SPA paths", () => {
    for (const p of [
      "/v1/x",
      "/api/auth/session",
      "/raw/ab/v/1/index.html",
      "/healthz",
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-protected-resource",
      "/robots.txt",
    ])
      expect(isApiPath(p)).toBe(true)
    for (const p of [
      "/",
      "/archived",
      "/artifacts/abc123",
      "/login",
      "/settings/agents",
      "/library",
    ])
      expect(isApiPath(p)).toBe(false)
  })

  it("serves the shell only for real client routes and returns real 404s elsewhere", async () => {
    const app = makeApp("SHELL_MARKER")
    expect((await app.request("/v1/ping")).status).toBe(200) // a real API route still wins
    for (const p of ["/", "/artifacts/xyz", "/settings/agents"]) {
      const r = await app.request(p)
      expect(r.status).toBe(200)
      expect(await r.text()).toContain("SHELL_MARKER") // deep client links → shell
    }
    const miss = await app.request("/v1/nope")
    expect(miss.status).toBe(404) // unknown API path → JSON 404, never the shell
    expect(await miss.json()).toEqual({ error: "not found" })
    const pageMiss = await app.request("/definitely-not-a-route")
    expect(pageMiss.status).toBe(404)
    expect(await pageMiss.text()).toBe("not found")
  })

  it("keeps the route allowlist aligned with the generated client tree", () => {
    for (const path of [
      "/",
      "/artifacts/a1b2c3d4",
      "/claim/token",
      "/collections/collection-id",
      "/contexts/context-id",
      "/invite/token",
      "/invite/a/token",
      "/invite/c/token",
      "/settings/members",
      "/showcase",
      "/templates",
      "/templates/weekly-review-abc123",
      "/users/maya",
      "/workflows",
    ])
      expect(isSpaPath(path)).toBe(true)
    for (const path of [
      "/artifacts",
      "/collections",
      "/invite/a/b/c",
      "/users",
      "/unknown",
      "/settings/a/b",
    ])
      expect(isSpaPath(path)).toBe(false)

    const routeTree = readFileSync(join(apiDir, "../web/src/routeTree.gen.ts"), "utf8")
    const generatedPaths = [...routeTree.matchAll(/fullPath: '([^']+)'/g)].map(
      (match) => match[1] ?? "",
    )
    expect(generatedPaths.length).toBeGreaterThan(20)
    for (const generatedPath of generatedPaths) {
      const sample = generatedPath.replace(/\$[^/]+/g, "example")
      expect(isSpaPath(sample), `${generatedPath} must be represented by isSpaPath`).toBe(true)
    }
  })

  it("serves the retired GitHub settings path through the SPA while keeping setup server-owned", () => {
    expect(isSpaPath("/settings/github")).toBe(true)
    expect(isServerRenderedPath("/settings/github")).toBe(false)
    expect(isServerRenderedPath("/settings/github/app/new")).toBe(true)
  })
})

// The public-site upstream (deps.site). derive.to's pages, sitemap and trust files
// live in their own Worker; on Node the not-found fallback forwards any navigation
// the app does not own to it, and the site answers with its own status — including
// its 404 page. Without the upstream (every self-host) the app's 404 stands.
describe("serve-web: navigations the app does not own go to the site upstream", () => {
  const site = async (req: Request): Promise<Response> => {
    const path = new URL(req.url).pathname
    if (path === "/pricing")
      return new Response("SITE PRICING", {
        headers: { "Content-Type": "text/html", "Cache-Control": "public, max-age=300" },
      })
    if (path === "/.well-known/security.txt")
      return new Response("Contact: mailto:security@x", {
        headers: { "Content-Type": "text/plain" },
      })
    return new Response("SITE 404 PAGE", { status: 404, headers: { "Content-Type": "text/html" } })
  }

  const app = (withSite: boolean) => {
    const a = new Hono()
    // A server-owned well-known, mounted before mountWeb exactly as node.ts does.
    a.get("/.well-known/openid-configuration", (c) => c.json({ issuer: "https://x" }))
    mountWeb(a, { webRoot: ".", shellHtml: "SHELL_MARKER", site: withSite ? site : undefined })
    return a
  }

  it("forwards pages and trust files whole, headers included", async () => {
    const pricing = await app(true).request("/pricing")
    expect(pricing.status).toBe(200)
    expect(await pricing.text()).toBe("SITE PRICING")
    expect(pricing.headers.get("cache-control")).toBe("public, max-age=300")

    const sec = await app(true).request("/.well-known/security.txt")
    expect(await sec.text()).toContain("Contact: mailto:security@x")
  })

  it("lets the site answer unknown paths with its own 404 page", async () => {
    const miss = await app(true).request("/definitely-not-a-route")
    expect(miss.status).toBe(404)
    expect(await miss.text()).toBe("SITE 404 PAGE")
  })

  it("keeps the app's own routes out of the upstream", async () => {
    // SPA routes stay the shell; API misses stay JSON; non-navigations never forward.
    expect(await (await app(true).request("/login")).text()).toContain("SHELL_MARKER")
    const api = await app(true).request("/v1/nope")
    expect(await api.json()).toEqual({ error: "not found" })
    const post = await app(true).request("/pricing", { method: "POST" })
    expect(post.status).toBe(404)
    expect(await post.text()).toBe("not found")

    const oidc = await app(true).request("/.well-known/openid-configuration")
    expect(await oidc.json()).toEqual({ issuer: "https://x" })
    // Unknown path under an API-owned well-known prefix stays a JSON 404 — never
    // the shell, never the site.
    const skills = await app(true).request("/.well-known/skills/nope.json")
    expect(await skills.json()).toEqual({ error: "not found" })
  })

  it("without the upstream, the app's 404 stands (every self-host)", async () => {
    const miss = await app(false).request("/pricing")
    expect(miss.status).toBe(404)
    expect(await miss.text()).toBe("not found")
  })
})

// The server-owned path set is declared in three places that can't share a value:
// the Node server (the contract above), the Cloudflare Worker, and the dev proxy.
// These assert the other two never drift from the contract.
describe("serve-web: every declaration of the path set agrees", () => {
  it("keeps only the agent-documentation files on the asset binding", () => {
    for (const path of ["/llms.txt", "/llms-full.txt"])
      expect(isStaticRootPath(path), `${path} must reach the asset binding`).toBe(true)
    // The site Worker owns these now; robots.txt is an app route (routes/site.ts).
    for (const path of [
      "/security",
      "/security.html",
      "/.well-known/security.txt",
      "/robots.txt",
      "/sitemap.xml",
    ])
      expect(isStaticRootPath(path), `${path} must NOT reach the asset binding`).toBe(false)
  })

  it("the Vite dev proxy list == the contract", () => {
    const vite = readFileSync(join(apiDir, "../web/vite.config.ts"), "utf8")
    const m = vite.match(/(\[\s*"\/[^\]]*\])\.map\(\(p\)\s*=>/)
    if (!m) throw new Error("dev proxy path list not found in vite.config.ts")
    expect(quoted(m[1] ?? "").sort()).toEqual([...API_PATHS].sort())
  })
})
