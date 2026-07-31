import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { FsBlobStore } from "@derive/storage/fs"
import { afterAll, describe, expect, it } from "vitest"
import { createApp } from "../src/app"

// The two files that decide whether a derive link opens the NATIVE app or a browser tab.
// The OS fetches them unauthenticated at install time, so the shapes here are not
// cosmetic: a wrong content type or a missing exclusion fails silently, and the only
// symptom is that links quietly stay web links.
const dir = mkdtempSync(join(tmpdir(), "derive-app-links-"))
const BASE = "http://localhost:8080"

const appWith = (deps: { appleAppId?: string; androidFingerprints?: string }) =>
  createApp({
    meta: new SqliteMetaStore(join(dir, `${Math.abs(hash(JSON.stringify(deps)))}.db`)),
    blobs: new FsBlobStore(join(dir, "blobs")),
    baseUrl: BASE,
    ...deps,
  })

// Small stable hash so each variant gets its own sqlite file without Math.random.
function hash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return h
}

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe("app-association files", () => {
  it("serves the iOS association when an app id is configured", async () => {
    const app = appWith({ appleAppId: "ABCDE12345.to.derive.app" })
    const res = await app.request(`${BASE}/.well-known/apple-app-site-association`)
    expect(res.status).toBe(200)
    // iOS REJECTS an AASA that is not application/json, and says nothing about it.
    expect(res.headers.get("content-type")).toContain("application/json")

    const body = (await res.json()) as {
      applinks: { details: { appIDs: string[]; components: Record<string, unknown>[] }[] }
    }
    const detail = body.applinks.details[0]
    expect(detail?.appIDs).toEqual(["ABCDE12345.to.derive.app"])

    // Artifact bytes and the API must be EXCLUDED. They are fetched, not navigated to,
    // and claiming them would route background asset requests into the app.
    const excluded = (detail?.components ?? []).filter((c) => c.exclude === true).map((c) => c["/"])
    expect(excluded).toContain("/raw/*")
    expect(excluded).toContain("/api/*")
    // ...and everything else still opens the app, or the file does nothing useful.
    expect((detail?.components ?? []).some((c) => c["/"] === "/*" && !c.exclude)).toBe(true)
  })

  it("serves the Android association when fingerprints are configured", async () => {
    const app = appWith({ androidFingerprints: "AA:BB:CC, DD:EE:FF" })
    const res = await app.request(`${BASE}/.well-known/assetlinks.json`)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("application/json")

    const body = (await res.json()) as {
      relation: string[]
      target: { package_name: string; sha256_cert_fingerprints: string[] }
    }[]
    expect(body[0]?.relation).toContain("delegate_permission/common.handle_all_urls")
    // Comma-separated input is split and trimmed, so a copy-paste with spaces works.
    expect(body[0]?.target.sha256_cert_fingerprints).toEqual(["AA:BB:CC", "DD:EE:FF"])
  })

  it("404s both when nothing is configured", async () => {
    // The default, and the important one: an instance with no app of its own must not
    // publish an association. Doing so would hand whatever app is named the right to
    // claim this domain's links.
    const app = appWith({})
    expect((await app.request(`${BASE}/.well-known/apple-app-site-association`)).status).toBe(404)
    expect((await app.request(`${BASE}/.well-known/assetlinks.json`)).status).toBe(404)
  })

  it("404s the Android file when only iOS is configured, and vice versa", async () => {
    const ios = appWith({ appleAppId: "ABCDE12345.to.derive.app" })
    expect((await ios.request(`${BASE}/.well-known/assetlinks.json`)).status).toBe(404)

    const android = appWith({ androidFingerprints: "AA:BB:CC" })
    expect((await android.request(`${BASE}/.well-known/apple-app-site-association`)).status).toBe(
      404,
    )
  })

  it("treats blank or comma-only config as unset", async () => {
    // An operator who sets the var to an empty string means "off", not "serve an empty
    // association" — an assetlinks with no fingerprints verifies nothing.
    const blank = appWith({ appleAppId: "   ", androidFingerprints: " , , " })
    expect((await blank.request(`${BASE}/.well-known/apple-app-site-association`)).status).toBe(404)
    expect((await blank.request(`${BASE}/.well-known/assetlinks.json`)).status).toBe(404)
  })

  it("needs no session: the OS fetches these signed out", async () => {
    const app = appWith({ appleAppId: "ABCDE12345.to.derive.app" })
    const res = await app.request(`${BASE}/.well-known/apple-app-site-association`, {
      headers: { "user-agent": "AASA-Bot/1.0" },
    })
    expect(res.status).toBe(200)
  })
})
