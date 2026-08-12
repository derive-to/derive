import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { loadConfig, resolveAuthSecret, resolveDefaultOrg } from "../src/config"

// loadConfig should fail fast at boot on a malformed value rather than coercing it
// to a silent default (or failing lazily on the first request that touches it).
describe("config: fail-fast env validation", () => {
  const base = { PORT: "8080", BASE_URL: "http://derive.test" }

  it("accepts a clean environment", () => {
    expect(loadConfig({ ...base }).port).toBe(8080)
  })

  it("rejects a non-numeric PORT", () => {
    expect(() => loadConfig({ ...base, PORT: "nope" })).toThrow(/PORT/)
  })

  it("rejects a zero / negative PORT", () => {
    expect(() => loadConfig({ ...base, PORT: "0" })).toThrow(/PORT/)
    expect(() => loadConfig({ ...base, PORT: "-1" })).toThrow(/PORT/)
  })

  it("rejects a malformed BASE_URL", () => {
    expect(() => loadConfig({ ...base, BASE_URL: "not a url" })).toThrow(/BASE_URL/)
  })

  it("rejects a malformed DATABASE_URL instead of failing at first query", () => {
    expect(() => loadConfig({ ...base, DATABASE_URL: "not a url" })).toThrow(/DATABASE_URL/)
  })

  it("requires shared identity settings with Postgres", () => {
    const database = "postgres://derive:password@db.example.com:5432/derive"
    expect(() => loadConfig({ ...base, DATABASE_URL: database })).toThrow(/DERIVE_AUTH_SECRET/)
    expect(() =>
      loadConfig({
        ...base,
        DATABASE_URL: database,
        DERIVE_AUTH_SECRET: "shared-secret-0123456789",
      }),
    ).toThrow(/DERIVE_DEFAULT_ORG_ID/)
    expect(
      loadConfig({
        ...base,
        DATABASE_URL: database,
        DERIVE_AUTH_SECRET: "shared-secret-0123456789",
        DERIVE_DEFAULT_ORG_ID: "ws_shared",
      }).databaseUrl,
    ).toBe(database)
  })

  it("rejects a malformed OBJECT_STORE_URL", () => {
    expect(() => loadConfig({ ...base, OBJECT_STORE_URL: "::::" })).toThrow(/OBJECT_STORE_URL/)
  })

  it("rejects a non-numeric retention window", () => {
    expect(() => loadConfig({ ...base, DERIVE_ANALYTICS_RETENTION_DAYS: "abc" })).toThrow(
      /RETENTION/,
    )
  })

  it("ignores an invalid quota knob (no-limit) without throwing", () => {
    // A typo'd cap is "no limit", warned not fatal — it shouldn't take the app down.
    expect(loadConfig({ ...base, DERIVE_MAX_ARTIFACTS: "lots" }).maxArtifacts).toBeUndefined()
  })

  it("rejects a malformed DERIVE_BILLING_ENFORCE_AT (a typo'd date must not silently never enforce)", () => {
    expect(() => loadConfig({ ...base, DERIVE_BILLING_ENFORCE_AT: "not-a-date" })).toThrow(
      /DERIVE_BILLING_ENFORCE_AT/,
    )
  })

  it("accepts a well-formed DERIVE_BILLING_ENFORCE_AT", () => {
    expect(
      loadConfig({ ...base, DERIVE_BILLING_ENFORCE_AT: "2026-01-01T00:00:00.000Z" })
        .billingEnforceAt,
    ).toBe("2026-01-01T00:00:00.000Z")
  })

  it("leaves DERIVE_BILLING_ENFORCE_AT unset when the env var is unset", () => {
    expect(loadConfig({ ...base }).billingEnforceAt).toBeUndefined()
  })
})

// The dense-search embedder is selected by DERIVE_EMBED_PROVIDER; `workersai` additionally needs
// the CF creds. A set-but-incomplete/typo'd provider must resolve to OFF (lexical), not a crash.
describe("config: denseSearch provider resolution", () => {
  const base = { PORT: "8080", BASE_URL: "http://derive.test" }

  it("unset ⇒ off (lexical-only, the default)", () => {
    expect(loadConfig({ ...base }).denseSearch).toBeUndefined()
  })

  it("provider=local ⇒ local, no credentials required", () => {
    expect(loadConfig({ ...base, DERIVE_EMBED_PROVIDER: "local" }).denseSearch).toEqual({
      provider: "local",
    })
  })

  it("provider=workersai WITH both CF vars ⇒ workersai", () => {
    expect(
      loadConfig({
        ...base,
        DERIVE_EMBED_PROVIDER: "workersai",
        DERIVE_EMBED_CF_ACCOUNT_ID: "acct",
        DERIVE_EMBED_CF_API_TOKEN: "tok",
      }).denseSearch,
    ).toEqual({ provider: "workersai", accountId: "acct", apiToken: "tok" })
  })

  it("provider=workersai but missing a CF var ⇒ off (not a broken half-config)", () => {
    expect(
      loadConfig({
        ...base,
        DERIVE_EMBED_PROVIDER: "workersai",
        DERIVE_EMBED_CF_ACCOUNT_ID: "acct",
      }).denseSearch,
    ).toBeUndefined()
  })

  it("an unknown provider value ⇒ off (not a crash)", () => {
    expect(loadConfig({ ...base, DERIVE_EMBED_PROVIDER: "openai" }).denseSearch).toBeUndefined()
  })
})

// The public origin drives auth cookies + share links. An explicit BASE_URL always
// wins; otherwise infer the URL a managed host assigned us, so a one-click deploy
// gets working auth without anyone hand-typing the domain.
describe("config: baseUrl inference", () => {
  it("prefers an explicit BASE_URL over everything", () => {
    const c = loadConfig({
      BASE_URL: "https://derive.example.com",
      RAILWAY_PUBLIC_DOMAIN: "ignored.up.railway.app",
      FLY_APP_NAME: "ignored",
    })
    expect(c.baseUrl).toBe("https://derive.example.com")
  })

  it("infers https from RAILWAY_PUBLIC_DOMAIN", () => {
    expect(loadConfig({ RAILWAY_PUBLIC_DOMAIN: "derive.up.railway.app" }).baseUrl).toBe(
      "https://derive.up.railway.app",
    )
  })

  it("uses RENDER_EXTERNAL_URL verbatim (it already carries the scheme)", () => {
    expect(loadConfig({ RENDER_EXTERNAL_URL: "https://derive.onrender.com" }).baseUrl).toBe(
      "https://derive.onrender.com",
    )
  })

  it("infers https://<app>.fly.dev from FLY_APP_NAME", () => {
    expect(loadConfig({ FLY_APP_NAME: "my-derive" }).baseUrl).toBe("https://my-derive.fly.dev")
  })

  it("falls back to http://localhost:<port> with nothing set", () => {
    expect(loadConfig({ PORT: "9090" }).baseUrl).toBe("http://localhost:9090")
  })

  it("orders the managed hosts Railway > Render > Fly", () => {
    const c = loadConfig({
      RAILWAY_PUBLIC_DOMAIN: "r.up.railway.app",
      RENDER_EXTERNAL_URL: "https://render.example",
      FLY_APP_NAME: "fly-app",
    })
    expect(c.baseUrl).toBe("https://r.up.railway.app")
  })
})

// The env -> Config field mapping: defaults, on/off knobs, list parsing, and the
// derived bundled-SPA flags. These feed every downstream subsystem.
describe("config: field mapping", () => {
  const base = { PORT: "8080", BASE_URL: "http://derive.test" }

  it("defaults analytics + rate limiting on, and turns them off only on 'false'", () => {
    const on = loadConfig({ ...base })
    expect(on.analytics).toBe(true)
    expect(on.rateLimit).toBe(true)
    const off = loadConfig({ ...base, DERIVE_ANALYTICS: "false", DERIVE_RATE_LIMIT: "false" })
    expect(off.analytics).toBe(false)
    expect(off.rateLimit).toBe(false)
  })

  it("previews defaults false and turns on only when DERIVE_PREVIEWS='true'", () => {
    // Default: unset → false
    expect(loadConfig({ ...base }).previews).toBe(false)
    // Explicitly false → still false
    expect(loadConfig({ ...base, DERIVE_PREVIEWS: "false" }).previews).toBe(false)
    // Opt-in → true
    expect(loadConfig({ ...base, DERIVE_PREVIEWS: "true" }).previews).toBe(true)
  })

  it("parses superAdmins as a trimmed, lowercased, comma-separated list", () => {
    const c = loadConfig({ ...base, DERIVE_SUPERADMIN_EMAILS: " Amy@X.com , bob@y.com ,," })
    expect(c.superAdmins).toEqual(["amy@x.com", "bob@y.com"])
  })

  it("normalizes subdomainBase (lowercase, strips leading/trailing dots)", () => {
    expect(loadConfig({ ...base, DERIVE_SUBDOMAIN_BASE: ".Derived.App." }).subdomainBase).toBe(
      "derived.app",
    )
    expect(loadConfig({ ...base, DERIVE_SUBDOMAIN_BASE: "" }).subdomainBase).toBeUndefined()
  })

  it("turns the version window from minutes into ms", () => {
    expect(loadConfig({ ...base, DERIVE_VERSION_WINDOW: "5" }).versionWindowMs).toBe(300_000)
    expect(loadConfig({ ...base }).versionWindowMs).toBeUndefined()
  })

  it("parses the web-origin allowlist and crossSite flag", () => {
    const c = loadConfig({
      ...base,
      DERIVE_WEB_ORIGIN: "https://a.com, https://b.com",
      DERIVE_CROSS_SITE: "true",
    })
    expect(c.webOrigins).toEqual(["https://a.com", "https://b.com"])
    expect(c.crossSite).toBe(true)
  })

  it("serveWeb is false when no built shell is present (empty DERIVE_WEB_DIR)", () => {
    const empty = mkdtempSync(join(tmpdir(), "derive-webdir-"))
    try {
      const c = loadConfig({ ...base, DERIVE_WEB_DIR: empty })
      expect(c.serveWeb).toBe(false)
      expect(c.webDir).toBe(empty)
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  it("serveWeb is true and webShell points at index.html when the SPA is built", () => {
    const dir = mkdtempSync(join(tmpdir(), "derive-webdir-"))
    try {
      writeFileSync(join(dir, "index.html"), "<!doctype html>")
      const c = loadConfig({ ...base, DERIVE_WEB_DIR: dir })
      expect(c.serveWeb).toBe(true)
      expect(c.webShell).toBe(join(dir, "index.html"))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// A stable session-signing secret survives restarts (or zero-config self-host would
// invalidate every session on each boot). Explicit env wins; else persist beside data.
describe("config: resolveAuthSecret", () => {
  let dir: string
  const saved = process.env.DERIVE_AUTH_SECRET
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "derive-secret-"))
    delete process.env.DERIVE_AUTH_SECRET
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    if (saved === undefined) delete process.env.DERIVE_AUTH_SECRET
    else process.env.DERIVE_AUTH_SECRET = saved
  })

  it("uses an explicit DERIVE_AUTH_SECRET (>= 16 chars)", () => {
    process.env.DERIVE_AUTH_SECRET = "a-very-long-explicit-secret"
    expect(resolveAuthSecret(dir)).toBe("a-very-long-explicit-secret")
  })

  it("ignores a too-short env secret and generates+persists one instead", () => {
    process.env.DERIVE_AUTH_SECRET = "short"
    const s = resolveAuthSecret(dir)
    expect(s).not.toBe("short")
    expect(s.length).toBeGreaterThanOrEqual(32)
    // Persisted so the next boot reuses it.
    expect(readFileSync(join(dir, ".auth-secret"), "utf8").trim()).toBe(s)
  })

  it("reuses the persisted secret on a later call (stable across restarts)", () => {
    const first = resolveAuthSecret(dir)
    expect(resolveAuthSecret(dir)).toBe(first)
  })
})

// The bootstrap workspace id is a real persisted value, so enabling multi-workspace
// later needs no data migration.
describe("config: resolveDefaultOrg", () => {
  let dir: string
  const saved = process.env.DERIVE_DEFAULT_ORG_ID
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "derive-org-"))
    delete process.env.DERIVE_DEFAULT_ORG_ID
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    if (saved === undefined) delete process.env.DERIVE_DEFAULT_ORG_ID
    else process.env.DERIVE_DEFAULT_ORG_ID = saved
  })

  it("uses an explicit DERIVE_DEFAULT_ORG_ID", () => {
    process.env.DERIVE_DEFAULT_ORG_ID = "ws_explicit"
    expect(resolveDefaultOrg(dir)).toBe("ws_explicit")
  })

  it("generates a ws_-prefixed id, persists it, and reuses it", () => {
    const id = resolveDefaultOrg(dir)
    expect(id).toMatch(/^ws_[0-9a-f]+$/)
    expect(readFileSync(join(dir, ".org-id"), "utf8").trim()).toBe(id)
    expect(resolveDefaultOrg(dir)).toBe(id)
  })
})
