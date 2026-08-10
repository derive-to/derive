import { zipSync } from "fflate"
import { describe, expect, it } from "vitest"
import { sweepExpiredDrafts } from "../src/lib/drafts"
import { as, makeAuthedApp } from "./helpers"

// Anonymous drafts — the account-less publish → claim flow. An agent with no
// credentials POSTs a file, gets a live expiring page on the usercontent domain
// plus a claim URL; a signed-in human spends the claim to pull the draft into
// their workspace. These run against a fake-auth app so both the anonymous mint
// (no x-test-user header) and the signed-in claim are exercised for real.
const BASE = "drafts.test"
const SECRET = "0".repeat(64)
const { app: drafts, meta } = makeAuthedApp(
  "drafts",
  [{ id: "u_alice", email: "alice@x.test", name: "Alice" }],
  undefined,
  { deps: { subdomainBase: BASE, encryptionKey: SECRET } },
)

const mint = async (content: string, extra: Record<string, string> = {}) => {
  const form = new FormData()
  form.append("file", new Blob([new TextEncoder().encode(content)]), "page.html")
  for (const [k, v] of Object.entries(extra)) form.append(k, v)
  return drafts.request("/v1/drafts", { method: "POST", body: form })
}

describe("POST /v1/drafts (anonymous mint)", () => {
  it("publishes an expiring draft with a live subdomain URL and a claim URL", async () => {
    const res = await mint("<h1>Hello draft</h1>")
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.short_id).toBeTruthy()
    expect(body.draft_url).toBe(`https://${body.short_id}.${BASE}/`)
    expect(body.claim_url).toContain("http://derive.test/claim/")
    // ~72h out, ISO.
    const ttlMs = Date.parse(body.expires_at) - Date.now()
    expect(ttlMs).toBeGreaterThan(71 * 3600_000)
    expect(ttlMs).toBeLessThan(73 * 3600_000)

    // Live on its own host, never CDN-cacheable.
    const served = await drafts.request(`http://${body.short_id}.${BASE}/`)
    expect(served.status).toBe(200)
    const html = await served.text()
    expect(html).toContain("Hello draft")
    expect(served.headers.get("cache-control")).toBe("no-store")
    // Standalone hosts get no anchor client: its comment UI only works embedded in
    // the app viewer, and a vanity/draft page is never iframed by the app.
    expect(html).not.toContain("/raw/derive-client.js")
    // A draft page names its host: the discovery chip carries attribution + the
    // expiry nudge. It is serve-time chrome, never part of the stored bytes.
    expect(html).toContain("data-derive-draft-chip")
    expect(html).toContain("Made with Derive")
    expect(html).toMatch(/expires in ~\d+h/)
    expect(html).toContain("http://derive.test/?src=draft_chip")
    // The same artifact through the raw route (which the viewer embeds) keeps the
    // anchor client and gets NO chip — the viewer is already Derive chrome.
    const raw = await drafts.request(`/raw/${body.short_id}/v/1/index.html`)
    expect(raw.status).toBe(200)
    const rawHtml = await raw.text()
    expect(rawHtml).toContain("/raw/derive-client.js")
    expect(rawHtml).not.toContain("data-derive-draft-chip")
  })

  it("chips every rendered page of a bundle draft, and only those", async () => {
    const zip = zipSync({
      "index.html": new TextEncoder().encode("<h1>Site</h1><script src=app.js></script>"),
      "notes.md": new TextEncoder().encode("# Notes"),
      "app.js": new TextEncoder().encode("console.log(1)"),
    })
    const form = new FormData()
    form.append("file", new Blob([zip]), "site.zip")
    const res = await drafts.request("/v1/drafts", { method: "POST", body: form })
    expect(res.status).toBe(201)
    const { short_id } = await res.json()
    const page = async (path: string) => {
      const r = await drafts.request(`http://${short_id}.${BASE}/${path}`)
      expect(r.status).toBe(200)
      return r.text()
    }
    // HTML pages and rendered markdown carry the chip; code assets must not —
    // a chip inside a script the page loads would break the page.
    expect(await page("")).toContain("data-derive-draft-chip")
    expect(await page("notes.md")).toContain("data-derive-draft-chip")
    expect(await page("app.js")).not.toContain("data-derive-draft-chip")
  })

  it("forces the draft access shape — client access fields are ignored", async () => {
    const res = await mint("<p>sneaky</p>", {
      listed: "public",
      workspace_access: "member",
      link_role: "editor",
      password: "hunter2",
    })
    expect(res.status).toBe(201)
    const { short_id } = await res.json()
    const a = await meta.getByShortId(short_id)
    expect(a?.org_id).toBe("ws_sys_drafts")
    expect(a?.workspace_access).toBe("none")
    expect(a?.link_role).toBe("viewer")
    expect(a?.listed).toBe("none")
    expect(a?.password_hash).toBeNull()
    expect(a?.expires_at).toBeTruthy()
    // Ownerless: no author, no member row.
    expect(a?.author_id ?? null).toBeNull()
  })

  it("410s an expired draft at its host instead of serving stale bytes", async () => {
    const res = await mint("<p>old</p>")
    const { short_id } = await res.json()
    const a = await meta.getByShortId(short_id)
    if (!a) throw new Error("draft missing")
    await meta.setArtifactExpiry(a.id, new Date(Date.now() - 1000).toISOString())
    const served = await drafts.request(`http://${short_id}.${BASE}/`)
    expect(served.status).toBe(410)
    // The tombstone is a small branded page, not a dead-end text line: a shared
    // link that outlived its draft still explains what this was and where to go.
    expect(served.headers.get("content-type")).toContain("text/html")
    const gone = await served.text()
    expect(gone).toContain("draft expired")
    expect(gone).toContain("http://derive.test")
    expect(served.headers.get("cache-control")).toBe("no-store")
  })
})

describe("the claim flow", () => {
  const mintAndToken = async () => {
    const res = await mint("<h1>Claim me</h1>")
    const body = await res.json()
    return { ...body, token: (body.claim_url as string).split("/claim/")[1] }
  }

  it("describes the draft to the claim page (public read)", async () => {
    const { token, short_id } = await mintAndToken()
    const info = await drafts.request(`/v1/drafts/claim/${token}`)
    expect(info.status).toBe(200)
    const j = await info.json()
    expect(j.short_id).toBe(short_id)
    expect(j.draft_url).toBe(`https://${short_id}.${BASE}/`)
  })

  it("refuses an anonymous claim at the door", async () => {
    const { token } = await mintAndToken()
    const res = await drafts.request("/v1/drafts/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    })
    // The global anonymous-write lockdown: /v1/drafts/claim is not allow-listed.
    expect(res.status).toBe(403)
  })

  it("moves the draft into the claimer's workspace and signposts the old host", async () => {
    const { token, short_id } = await mintAndToken()
    const res = await drafts.request("/v1/drafts/claim", {
      method: "POST",
      headers: { "content-type": "application/json", ...as("alice@x.test") },
      body: JSON.stringify({ token }),
    })
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.org_id).toBe("default")
    expect(j.url).toContain(short_id)

    const a = await meta.getByShortId(short_id)
    expect(a?.org_id).toBe("default")
    expect(a?.expires_at).toBeNull()
    // Sheds the draft shape for the workspace default (team draft).
    expect(a?.link_role).toBe("none")
    expect(a?.workspace_access).toBe("member")
    // Ownership landed.
    if (!a) throw new Error("artifact missing")
    const members = await meta.listArtifactMembers(a.id)
    expect(members.some((m) => m.user_id === "u_alice" && m.role === "owner")).toBe(true)

    // The shared draft URL survives as a signpost to the permanent home.
    const redirected = await drafts.request(`http://${short_id}.${BASE}/`, { redirect: "manual" })
    expect(redirected.status).toBe(302)
    expect(redirected.headers.get("location")).toBe(j.url)
    expect(redirected.headers.get("cache-control")).toBe("no-store")

    // Single-use by state: a replayed token finds nothing to spend.
    const replay = await drafts.request("/v1/drafts/claim", {
      method: "POST",
      headers: { "content-type": "application/json", ...as("alice@x.test") },
      body: JSON.stringify({ token }),
    })
    expect(replay.status).toBe(410)
  })

  it("410s a claim on an expired draft", async () => {
    const { token, short_id } = await mintAndToken()
    const a = await meta.getByShortId(short_id)
    if (!a) throw new Error("draft missing")
    await meta.setArtifactExpiry(a.id, new Date(Date.now() - 1000).toISOString())
    const res = await drafts.request("/v1/drafts/claim", {
      method: "POST",
      headers: { "content-type": "application/json", ...as("alice@x.test") },
      body: JSON.stringify({ token }),
    })
    expect(res.status).toBe(410)
  })
})

describe("the sweep", () => {
  it("deletes expired drafts and their subdomain rows; leaves live ones", async () => {
    const dead = await (await mint("<p>doomed</p>")).json()
    const alive = await (await mint("<p>fine</p>")).json()
    const deadArt = await meta.getByShortId(dead.short_id)
    if (!deadArt) throw new Error("draft missing")
    await meta.setArtifactExpiry(deadArt.id, new Date(Date.now() - 1000).toISOString())

    const removed = await sweepExpiredDrafts(meta, undefined)
    expect(removed).toBeGreaterThanOrEqual(1)
    expect(await meta.getByShortId(dead.short_id)).toBeNull()
    expect(await meta.getDomain(`${dead.short_id}.${BASE}`)).toBeNull()
    expect(await meta.getByShortId(alive.short_id)).not.toBeNull()
    expect(await meta.getDomain(`${alive.short_id}.${BASE}`)).not.toBeNull()
  })
})
