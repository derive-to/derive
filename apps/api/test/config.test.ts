import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { loadConfig, resolveAuthSecret, resolveDefaultOrg } from "../src/config"

// loadConfig should fail fast at boot on a malformed value rather than coercing it
// to a silent default (or failing lazily on the first request that touches it).
describe("config: fail-fast env validation", () => {
  const base = { PORT: "8080", BASE_URL: "http://derive.test" }

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

  it("rejects a malformed DERIVE_BILLING_ENFORCE_AT (a typo'd date must not silently never enforce)", () => {
    expect(() => loadConfig({ ...base, DERIVE_BILLING_ENFORCE_AT: "not-a-date" })).toThrow(
      /DERIVE_BILLING_ENFORCE_AT/,
    )
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
})

// The env -> Config field mapping: defaults, on/off knobs, list parsing, and the
// derived bundled-SPA flags. These feed every downstream subsystem.
describe("config: field mapping", () => {
  const base = { PORT: "8080", BASE_URL: "http://derive.test" }

  it("parses superAdmins as a trimmed, lowercased, comma-separated list", () => {
    const c = loadConfig({ ...base, DERIVE_SUPERADMIN_EMAILS: " Amy@X.com , bob@y.com ,," })
    expect(c.superAdmins).toEqual(["amy@x.com", "bob@y.com"])
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

  it("generates a ws_-prefixed id, persists it, and reuses it", () => {
    const id = resolveDefaultOrg(dir)
    expect(id).toMatch(/^ws_[0-9a-f]+$/)
    expect(readFileSync(join(dir, ".org-id"), "utf8").trim()).toBe(id)
    expect(resolveDefaultOrg(dir)).toBe(id)
  })
})
