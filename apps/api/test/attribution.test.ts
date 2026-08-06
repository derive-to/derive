import { join } from "node:path"
import { FsBlobStore } from "@derive/storage/fs"
import { describe, expect, it } from "vitest"
import { createApp } from "../src/app"
import { parseSrcCookie, SRC_COOKIE } from "../src/lib/attribution"
import { dir, meta, TEST_TOKEN } from "./helpers"

const SHELL =
  "<!doctype html><html><head><title>Derive</title></head><body><div id=root></div></body></html>"
const HOME = "<!doctype html><html><body>MARKETING HOME</body></html>"

// Worker-shaped app (shellFetch, marketing) — the paths the capture middleware
// stamps are exactly the worker-first HTML entry points (/artifacts/:ref, /, /pricing).
const a = createApp({
  meta,
  blobs: new FsBlobStore(join(dir, "blobs-attribution")),
  baseUrl: "http://derive.test",
  token: TEST_TOKEN,
  shellFetch: async () => SHELL,
  marketing: { home: async () => HOME, pricing: async () => HOME, privacy: async () => HOME },
})

const BEARER = { authorization: `Bearer ${TEST_TOKEN}` }

// One published artifact for the share-link tests; the middleware stamps by path,
// independent of readability (an arrival is an arrival).
const publish = async (): Promise<string> => {
  const form = new FormData()
  form.append("file", new Blob([new TextEncoder().encode("<h1>hi</h1>")]), "f.html")
  form.append("title", "Attribution Doc")
  const res = await a.request("/v1/artifacts", { method: "POST", body: form, headers: BEARER })
  expect(res.status).toBe(201)
  return (await res.json()).short_id as string
}

const setCookies = (res: Response): string[] =>
  // getSetCookie keeps multiple Set-Cookie headers apart (get() would comma-join them).
  res.headers.getSetCookie?.() ?? []

const srcCookie = (res: Response): string | null => {
  const raw = setCookies(res).find((c) => c.startsWith(`${SRC_COOKIE}=`))
  return raw ?? null
}

// Decode the stamped value the way the signup hook will see it: as a Cookie header.
const decodeStamp = (setCookie: string) => {
  const pair = setCookie.split(";")[0] ?? ""
  return parseSrcCookie(pair)
}

describe("d_src capture middleware", () => {
  it("stamps artifact_visit on an anonymous artifact-page load, httpOnly + Lax + 30d", async () => {
    const shortId = await publish()
    const res = await a.request(`/artifacts/${shortId}`)
    const cookie = srcCookie(res)
    expect(cookie).toBeTruthy()
    // NOT HttpOnly: the SPA refines the surface on click (badge vs make-your-own)
    // by rewriting the cookie, and browsers ignore JS writes to HttpOnly cookies.
    expect(cookie).not.toContain("HttpOnly")
    expect(cookie).toContain("SameSite=Lax")
    expect(cookie).toContain("Max-Age=2592000")
    expect(cookie).toContain("Path=/")
    const parsed = decodeStamp(cookie ?? "")
    expect(parsed).toMatchObject({
      source_kind: "artifact_visit",
      source_artifact: shortId,
      landing_path: `/artifacts/${shortId}`,
    })
  })

  it("honors a ?src= override on the artifact page (the badge link)", async () => {
    const shortId = await publish()
    const res = await a.request(`/artifacts/${shortId}?src=badge`)
    const parsed = decodeStamp(srcCookie(res) ?? "")
    expect(parsed).toMatchObject({ source_kind: "badge", source_artifact: shortId })
  })

  it("stamps a campaign kind on / with ?src= (launch links), no artifact", async () => {
    const res = await a.request("/?src=hn-launch")
    const parsed = decodeStamp(srcCookie(res) ?? "")
    expect(parsed).toMatchObject({
      source_kind: "hn-launch",
      source_artifact: null,
      landing_path: "/",
    })
  })

  it("does not stamp a bare / load (an organic homepage view is not a source)", async () => {
    const res = await a.request("/")
    expect(srcCookie(res)).toBeNull()
  })

  it("does not stamp visitors who already have a session", async () => {
    const shortId = await publish()
    const res = await a.request(`/artifacts/${shortId}`, {
      headers: { cookie: "better-auth.session_token=abc" },
    })
    expect(srcCookie(res)).toBeNull()
  })

  it("falls back to artifact_visit when ?src= is malformed", async () => {
    const shortId = await publish()
    const res = await a.request(`/artifacts/${shortId}?src=${encodeURIComponent("<script>")}`)
    const parsed = decodeStamp(srcCookie(res) ?? "")
    expect(parsed).toMatchObject({ source_kind: "artifact_visit", source_artifact: shortId })
  })

  it("survives a ref with broken percent-encoding (no 500, stamp without artifact)", async () => {
    const res = await a.request("/artifacts/%E0%A4%A")
    expect(res.status).toBeLessThan(500)
    const parsed = decodeStamp(srcCookie(res) ?? "")
    expect(parsed).toMatchObject({ source_kind: "artifact_visit", source_artifact: null })
  })

  it("records the external referrer host, but never a same-host one", async () => {
    const shortId = await publish()
    const external = await a.request(`/artifacts/${shortId}`, {
      headers: { referer: "https://news.ycombinator.com/item?id=1" },
    })
    expect(decodeStamp(srcCookie(external) ?? "")?.referrer).toBe("news.ycombinator.com")

    const internal = await a.request(`/artifacts/${shortId}`, {
      headers: { host: "derive.test", referer: "http://derive.test/somewhere" },
    })
    expect(decodeStamp(srcCookie(internal) ?? "")?.referrer).toBeNull()
  })

  it("last touch wins: a later arrival overwrites the cookie", async () => {
    const first = await publish()
    const second = await publish()
    const res1 = await a.request(`/artifacts/${first}?src=badge`)
    expect(decodeStamp(srcCookie(res1) ?? "")?.source_artifact).toBe(first)
    // The browser re-sends the first cookie; the middleware still restamps.
    const pair = (srcCookie(res1) ?? "").split(";")[0] ?? ""
    const res2 = await a.request(`/artifacts/${second}`, { headers: { cookie: pair } })
    expect(decodeStamp(srcCookie(res2) ?? "")).toMatchObject({
      source_kind: "artifact_visit",
      source_artifact: second,
    })
  })

  it("never stamps API paths", async () => {
    const res = await a.request("/v1/artifacts", { headers: BEARER })
    expect(res.status).toBe(200)
    expect(srcCookie(res)).toBeNull()
  })
})

describe("parseSrcCookie", () => {
  it("returns null for an absent, foreign, or malformed cookie", () => {
    expect(parseSrcCookie(null)).toBeNull()
    expect(parseSrcCookie("")).toBeNull()
    expect(parseSrcCookie("other=1; theme=dark")).toBeNull()
    expect(parseSrcCookie(`${SRC_COOKIE}=%7Bnot-json`)).toBeNull()
    expect(parseSrcCookie(`${SRC_COOKIE}=${encodeURIComponent('{"x":1}')}`)).toBeNull()
  })

  it("rejects a stamp whose kind fails validation", () => {
    const bad = encodeURIComponent(JSON.stringify({ k: "<script>", p: "/" }))
    expect(parseSrcCookie(`${SRC_COOKIE}=${bad}`)).toBeNull()
  })

  it("drops an invalid artifact id but keeps the stamp", () => {
    const v = encodeURIComponent(JSON.stringify({ k: "badge", a: "NOT AN ID!!", p: "/" }))
    const parsed = parseSrcCookie(`${SRC_COOKIE}=${v}`)
    expect(parsed).toMatchObject({ source_kind: "badge", source_artifact: null })
  })

  it("finds the stamp among other cookies", () => {
    const v = encodeURIComponent(
      JSON.stringify({ k: "badge", a: "ab12cd34", p: "/x", r: "hn.com" }),
    )
    const parsed = parseSrcCookie(`theme=dark; ${SRC_COOKIE}=${v}; other=1`)
    expect(parsed).toMatchObject({
      source_kind: "badge",
      source_artifact: "ab12cd34",
      landing_path: "/x",
      referrer: "hn.com",
    })
  })
})
