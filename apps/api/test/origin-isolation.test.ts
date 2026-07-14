import { join } from "node:path"
import { FsBlobStore } from "@derive/storage/fs"
import { zipSync } from "fflate"
import { describe, expect, it } from "vitest"
import { createApp } from "../src/app"
import { autoSubdomainLabel, maybeAssignIsolatedSubdomain } from "../src/lib/after-publish"
import {
  headersFor,
  ISOLATED_RAW_HEADERS,
  RAW_HEADERS,
  sharesRegistrableDomain,
} from "../src/lib/http"
import { dir, makeStore } from "./helpers"

const csp = (h: Record<string, string>) => h["Content-Security-Policy"] ?? ""

describe("origin isolation — headersFor (2a)", () => {
  it("grants allow-same-origin ONLY on an isolated origin; the shared sandbox stays opaque", () => {
    expect(csp(headersFor(true))).toContain("allow-same-origin")
    expect(csp(headersFor(false))).not.toContain("allow-same-origin")
    // Same object identities the serve path uses — no accidental third variant.
    expect(headersFor(true)).toBe(ISOLATED_RAW_HEADERS)
    expect(headersFor(false)).toBe(RAW_HEADERS)
    // The isolated set is the opaque set PLUS the grant — nothing else weakened
    // (still sandboxed, still allow-scripts, still nosniff/noindex).
    expect(csp(ISOLATED_RAW_HEADERS)).toContain("sandbox")
    expect(csp(ISOLATED_RAW_HEADERS)).toContain("allow-scripts")
    // Neither top-navigation nor popup-escape is granted — an isolated artifact is
    // still cross-origin to the app/embedder and can't reach a parent context.
    expect(csp(ISOLATED_RAW_HEADERS)).not.toContain("allow-top-navigation")
    expect(csp(ISOLATED_RAW_HEADERS)).not.toContain("allow-popups-to-escape-sandbox")
    expect(ISOLATED_RAW_HEADERS["X-Content-Type-Options"]).toBe("nosniff")
  })
})

describe("origin isolation — deployment-invariant guard (sharesRegistrableDomain)", () => {
  it("flags a subdomain base on the SAME registrable domain as the app host (the cookie-injection footgun)", () => {
    // The dangerous misconfigurations: base == app host, base under the app host, or
    // the app host under the base — all share a registrable domain, so a Domain-scoped
    // cookie set by an artifact could reach the app.
    expect(sharesRegistrableDomain("derive.to", "derive.to")).toBe(true)
    expect(sharesRegistrableDomain("derive.to", "usercontent.derive.to")).toBe(true)
    expect(sharesRegistrableDomain("app.derive.to", "derive.to")).toBe(true)
    // Tolerates stray leading/trailing dots on the configured base.
    expect(sharesRegistrableDomain("derive.to", ".derive.to.")).toBe(true)
  })

  it("passes the intended prod config: a genuinely separate registrable domain", () => {
    expect(sharesRegistrableDomain("derive.to", "derived.app")).toBe(false)
    // A shared trailing LABEL that isn't a dotted-suffix must not false-positive
    // (derived.app vs derive.to share nothing; xderive.to is not a suffix of derive.to).
    expect(sharesRegistrableDomain("derive.to", "xderive.to")).toBe(false)
    expect(sharesRegistrableDomain(null, "derived.app")).toBe(false)
    expect(sharesRegistrableDomain("derive.to", "")).toBe(false)
  })
})

describe("origin isolation — serve path (2a + 2c end to end)", () => {
  const BASE = "derived.app"
  const meta = makeStore("iso-serve", [])
  const blobs = new FsBlobStore(join(dir, "blobs-iso-serve"))
  const app = createApp({
    meta,
    blobs,
    baseUrl: "http://derive.test",
    subdomainBase: BASE,
    token: "tok",
  })
  const H = { authorization: "Bearer tok" }

  const publish = async (content: string): Promise<string> => {
    const form = new FormData()
    form.append("file", new Blob([new TextEncoder().encode(content)]), "page.html")
    form.append("title", "Iso")
    form.append("visibility", "public")
    const res = await app.request("/v1/artifacts", { method: "POST", body: form, headers: H })
    return (await res.json()).short_id
  }

  it("an artifact-bound subdomain serves the capability grant + the history shim; the SAME artifact on /raw does NOT", async () => {
    const short = await publish("<!doctype html><html><body><h1>App</h1></body></html>")
    const put = await app.request(`/v1/artifacts/${short}/domains`, {
      method: "PUT",
      headers: { ...H, "content-type": "application/json" },
      body: JSON.stringify({ label: "myapp" }),
    })
    expect(put.status).toBe(201)

    // Isolated origin: allow-same-origin + the back-button shim injected.
    const iso = await app.request(`http://myapp.${BASE}/`, { headers: H })
    expect(iso.status).toBe(200)
    expect(iso.headers.get("content-security-policy")).toContain("allow-same-origin")
    const isoBody = await iso.text()
    expect(isoBody).toContain("data-derive-history-shim")
    expect(isoBody).toContain("App") // the real content still served

    // Same artifact, shared /raw origin: opaque sandbox, no grant, no shim.
    const raw = await app.request(`/raw/${short}/v/1/index.html`, { headers: H })
    expect(raw.status).toBe(200)
    expect(raw.headers.get("content-security-policy")).not.toContain("allow-same-origin")
    expect(await raw.text()).not.toContain("data-derive-history-shim")
  })
})

describe("origin isolation — auto-assigned subdomains (2b)", () => {
  it("autoSubdomainLabel is deterministic, unguessable-shaped, and a valid DNS label", async () => {
    const a = await autoSubdomainLabel("art_123", "salt-A")
    const again = await autoSubdomainLabel("art_123", "salt-A")
    expect(a).toBe(again) // deterministic → race-safe (same host on a concurrent publish)
    // Different artifact OR different salt → different label (no cross-artifact guessing).
    expect(await autoSubdomainLabel("art_456", "salt-A")).not.toBe(a)
    expect(await autoSubdomainLabel("art_123", "salt-B")).not.toBe(a)
    // Valid DNS label: leads with a letter, only [a-z0-9], reasonable length.
    expect(a).toMatch(/^d[a-z0-9]{20}$/)
  })

  const spaBundle = (marker: string): Uint8Array =>
    zipSync({ "index.html": new TextEncoder().encode(`<h1>${marker}</h1>`) })

  const mkArtifact = async (
    store: ReturnType<typeof makeStore>,
    opts: { kind: "file" | "bundle"; spa: 0 | 1 },
  ) => {
    const key = await new FsBlobStore(join(dir, "blobs-iso-auto")).put(spaBundle("x"))
    const a = await store.createArtifact({
      id: `art_${opts.kind}_${opts.spa}_${Math.random().toString(36).slice(2)}`,
      short_id: Math.random().toString(36).slice(2, 10),
      org_id: "org1",
      slug: null,
      title: "T",
      workspace_access: "member",
      link_role: "viewer",
      listed: "public",
      kind: opts.kind,
      spa: opts.spa,
    })
    void key
    return a
  }

  it("assigns an isolated subdomain to an SPA bundle, once (idempotent), and to nothing else", async () => {
    const store = makeStore("iso-auto", [])
    const deps = { meta: store, subdomainBase: "derived.app", subdomainSalt: "server-secret" }

    // An SPA bundle earns an auto subdomain.
    const spa = await mkArtifact(store, { kind: "bundle", spa: 1 })
    await maybeAssignIsolatedSubdomain(deps, spa)
    const doms = await store.getArtifactDomains(spa.id)
    expect(doms).toHaveLength(1)
    expect(doms[0]?.host).toBe(`${await autoSubdomainLabel(spa.id, "server-secret")}.derived.app`)
    expect(doms[0]?.kind).toBe("subdomain")

    // Idempotent: a second call (a later republish) adds nothing.
    await maybeAssignIsolatedSubdomain(deps, spa)
    expect(await store.getArtifactDomains(spa.id)).toHaveLength(1)

    // A plain single-file page and a non-SPA bundle get NOTHING (they render fine
    // on the shared sandbox; they don't each earn a DNS name).
    const plain = await mkArtifact(store, { kind: "file", spa: 0 })
    await maybeAssignIsolatedSubdomain(deps, plain)
    expect(await store.getArtifactDomains(plain.id)).toHaveLength(0)
    const staticBundle = await mkArtifact(store, { kind: "bundle", spa: 0 })
    await maybeAssignIsolatedSubdomain(deps, staticBundle)
    expect(await store.getArtifactDomains(staticBundle.id)).toHaveLength(0)
  })

  it("does nothing when domain mode is off (no subdomainBase) or no salt is configured", async () => {
    const store = makeStore("iso-auto-off", [])
    const spa = await mkArtifact(store, { kind: "bundle", spa: 1 })
    await maybeAssignIsolatedSubdomain({ meta: store, subdomainSalt: "s" }, spa) // no base
    await maybeAssignIsolatedSubdomain({ meta: store, subdomainBase: "derived.app" }, spa) // no salt
    expect(await store.getArtifactDomains(spa.id)).toHaveLength(0)
  })

  it("does not overwrite an existing vanity subdomain (already isolated)", async () => {
    const store = makeStore("iso-auto-vanity", [])
    const deps = { meta: store, subdomainBase: "derived.app", subdomainSalt: "s" }
    const spa = await mkArtifact(store, { kind: "bundle", spa: 1 })
    // Owner already picked a vanity name.
    await store.setDomain({
      host: "chosen.derived.app",
      artifact_id: spa.id,
      org_id: "org1",
      kind: "subdomain",
    })
    await maybeAssignIsolatedSubdomain(deps, spa)
    const doms = await store.getArtifactDomains(spa.id)
    expect(doms).toHaveLength(1)
    expect(doms[0]?.host).toBe("chosen.derived.app") // untouched, no auto host added
  })
})
