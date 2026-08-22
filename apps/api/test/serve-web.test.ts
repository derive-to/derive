import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Hono } from "hono"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { API_PATHS, isApiPath, mountWeb } from "../src/lib/serve-web"
import { isSpaPath, isStaticRootPath } from "../src/lib/spa-paths"

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
})

// The trust-signal static files (RFC 9116 security.txt, sitemap.xml). Both must
// serve their real bytes rather than the SPA shell — a scanner that gets HTML from
// /.well-known/security.txt reads it as a soft-404, which is the thing these were
// added to fix. sitemap.xml is covered by the root-file route; security.txt needs
// the dot-directory route, so this pins the one that is easy to regress.
describe("serve-web: static trust-signal files are not swallowed by the shell", () => {
  // serveStatic resolves `root` against process.cwd() (apps/api under vitest), so
  // the fixture has to live on disk under it rather than in a system temp dir.
  const rootRel = "test/.tmp-serve-web"
  const rootAbs = join(apiDir, rootRel)

  beforeAll(() => {
    mkdirSync(join(rootAbs, ".well-known"), { recursive: true })
    writeFileSync(join(rootAbs, ".well-known", "security.txt"), "Contact: mailto:security@x\n")
    writeFileSync(join(rootAbs, "sitemap.xml"), '<?xml version="1.0"?><urlset/>')
    writeFileSync(join(rootAbs, "security.html"), "<!doctype html><h1>Security</h1>")
  })
  afterAll(() => rmSync(rootAbs, { recursive: true, force: true }))

  const app = () => {
    const a = new Hono()
    // A server-owned well-known, mounted before mountWeb exactly as node.ts does.
    a.get("/.well-known/openid-configuration", (c) => c.json({ issuer: "https://x" }))
    mountWeb(a, { webRoot: rootRel, shellHtml: "SHELL_MARKER" })
    return a
  }

  it("serves security.txt and sitemap.xml as themselves", async () => {
    const sec = await app().request("/.well-known/security.txt")
    expect(sec.status).toBe(200)
    expect(await sec.text()).toContain("Contact: mailto:security@x")

    const map = await app().request("/sitemap.xml")
    expect(map.status).toBe(200)
    expect(await map.text()).toContain("<urlset/>")

    const page = await app().request("/security")
    expect(page.status).toBe(200)
    expect(page.headers.get("content-type")).toContain("text/html")
    expect(await page.text()).toContain("<h1>Security</h1>")
  })

  it("does not shadow server-owned well-knowns", async () => {
    const oidc = await app().request("/.well-known/openid-configuration")
    expect(oidc.status).toBe(200)
    expect(await oidc.json()).toEqual({ issuer: "https://x" })

    // Unknown path under an API-owned well-known prefix stays a JSON 404 — the
    // static route must fall through, never hand back the shell.
    const miss = await app().request("/.well-known/skills/nope.json")
    expect(miss.status).toBe(404)
    expect(await miss.json()).toEqual({ error: "not found" })
  })
})

// The server-owned path set is declared in three places that can't share a value:
// the Node server (the contract above), the Cloudflare Worker, and the dev proxy.
// These assert the other two never drift from the contract.
describe("serve-web: every declaration of the path set agrees", () => {
  it("sends the canonical security URL and trust-signal files to static assets", () => {
    for (const path of [
      "/security",
      "/security.html",
      "/.well-known/security.txt",
      "/llms.txt",
      "/robots.txt",
      "/sitemap.xml",
    ])
      expect(isStaticRootPath(path), `${path} must reach the asset binding`).toBe(true)
    expect(isStaticRootPath("/definitely-not-a-static-file")).toBe(false)
  })

  it("the Vite dev proxy list == the contract", () => {
    const vite = readFileSync(join(apiDir, "../web/vite.config.ts"), "utf8")
    const m = vite.match(/(\[\s*"\/[^\]]*\])\.map\(\(p\)\s*=>/)
    if (!m) throw new Error("dev proxy path list not found in vite.config.ts")
    expect(quoted(m[1] ?? "").sort()).toEqual([...API_PATHS].sort())
  })
})
