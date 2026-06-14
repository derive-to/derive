import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Hono } from "hono"
import { describe, expect, it } from "vitest"
import { API_PATHS, isApiPath, mountWeb, workerFirstGlobs } from "../src/lib/serve-web"

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
    for (const p of ["/", "/a/abc123", "/login", "/settings/agents", "/library"])
      expect(isApiPath(p)).toBe(false)
  })

  it("falls back to the SPA shell for non-API GETs, JSON 404 for unknown API paths", async () => {
    const app = makeApp("SHELL_MARKER")
    expect((await app.request("/v1/ping")).status).toBe(200) // a real API route still wins
    for (const p of ["/", "/a/xyz", "/settings/agents"]) {
      const r = await app.request(p)
      expect(r.status).toBe(200)
      expect(await r.text()).toContain("SHELL_MARKER") // deep client links → shell
    }
    const miss = await app.request("/v1/nope")
    expect(miss.status).toBe(404) // unknown API path → JSON 404, never the shell
    expect(await miss.json()).toEqual({ error: "not found" })
  })
})

// The server-owned path set is declared in three places that can't share a value:
// the Node server (the contract above), the Cloudflare Worker, and the dev proxy.
// These assert the other two never drift from the contract.
describe("serve-web: every declaration of the path set agrees", () => {
  it("wrangler.toml run_worker_first == the contract", () => {
    const toml = readFileSync(join(apiDir, "wrangler.toml"), "utf8")
    const m = toml.match(/run_worker_first\s*=\s*\[([^\]]*)\]/)
    if (!m) throw new Error("run_worker_first not found in wrangler.toml")
    expect(quoted(m[1] ?? "").sort()).toEqual([...workerFirstGlobs()].sort())
  })

  it("the Vite dev proxy list == the contract", () => {
    const vite = readFileSync(join(apiDir, "../web/vite.config.ts"), "utf8")
    const m = vite.match(/(\[\s*"\/[^\]]*\])\.map\(\(p\)\s*=>/)
    if (!m) throw new Error("dev proxy path list not found in vite.config.ts")
    expect(quoted(m[1] ?? "").sort()).toEqual([...API_PATHS].sort())
  })
})
