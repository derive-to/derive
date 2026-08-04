import { type ArtifactRecord, newId } from "@derive/core"
import { describe, expect, it } from "vitest"
import { artifactRefFromUrl, decideUnfurl } from "../src/lib/slack-unfurl"
import { quotaApp } from "./helpers"

const BASE = "https://derive.test"

describe("artifactRefFromUrl", () => {
  it("reads the ref out of a share URL on this instance", () => {
    expect(artifactRefFromUrl(BASE, `${BASE}/artifacts/spec-abc123`)).toBe("spec-abc123")
    expect(artifactRefFromUrl(BASE, `${BASE}/artifacts/abc123/`)).toBe("abc123")
    expect(artifactRefFromUrl(BASE, `${BASE}/artifacts/spec-abc123?comment=t1`)).toBe("spec-abc123")
  })

  // A vanity subdomain serves the same artifacts, and one registered unfurl domain covers all
  // of its subdomains — so these have to resolve too.
  it("accepts a vanity subdomain of the instance host", () => {
    expect(artifactRefFromUrl(BASE, "https://acme.derive.test/artifacts/abc123")).toBe("abc123")
  })

  // The host check is what stops a link to ANOTHER Derive instance resolving against our own
  // database and rendering someone else's artifact into this workspace's channel.
  it("refuses a different host, and non-artifact paths", () => {
    expect(artifactRefFromUrl(BASE, "https://evil.example/artifacts/abc123")).toBe(null)
    expect(artifactRefFromUrl(BASE, "https://notderive.test/artifacts/abc")).toBe(null)
    expect(artifactRefFromUrl(BASE, `${BASE}/pricing`)).toBe(null)
    expect(artifactRefFromUrl(BASE, `${BASE}/artifacts/abc/extra`)).toBe(null)
    expect(artifactRefFromUrl(BASE, "not a url")).toBe(null)
  })
})

describe("decideUnfurl — the broadcast gate", () => {
  const setup = async (name: string, listed: "none" | "workspace") => {
    const { meta } = quotaApp(name, { defaultOrgId: "default" }, [], [])
    const artifact = (await meta.createArtifact({
      id: newId("a"),
      short_id: newId("s").slice(0, 8),
      org_id: "default",
      slug: null,
      title: "Q4 plan",
      workspace_access: "member",
      link_role: "viewer",
      listed,
      kind: "file",
      spa: 0,
    })) as ArtifactRecord
    const deps = {
      meta,
      baseUrl: BASE,
      orgId: "default",
      canRead: async () => true,
    }
    return { meta, artifact, deps, url: `${BASE}/artifacts/${artifact.short_id}` }
  }

  // Without an account link there is no principal to authorize, so Slack's own sign-in prompt
  // is the answer — it is also the only per-person surface chat.unfurl offers.
  it("asks an unlinked sharer to connect", async () => {
    const { deps, url } = await setup("unfurl-unlinked", "workspace")
    expect((await decideUnfurl(deps, url, null)).kind).toBe("auth")
  })

  it("renders a card for a feed-visible artifact", async () => {
    const { deps, url } = await setup("unfurl-listed", "workspace")
    const d = await decideUnfurl(deps, url, "u-1")
    expect(d.kind).toBe("card")
    if (d.kind === "card") expect(JSON.stringify(d.blocks)).toContain("Q4 plan")
  })

  // The unfurl is seen by the whole channel, so a private draft gets a card that confirms
  // nothing beyond what the pasted URL already did — no title, no counts.
  // The title has to be absent in EVERY form it can take, not just verbatim. The canonical
  // share URL is `<slugified-title>-<short_id>`, so an earlier version of this test passed while
  // the card's href read `…/artifacts/q4-plan-vs8g8mh6` — the title was right there, lowercased
  // and hyphenated, recoverable by hovering the link.
  it("renders a locked card that leaks the title in no form, including the slug", async () => {
    const { deps, url, artifact } = await setup("unfurl-private", "none")
    const d = await decideUnfurl(deps, url, "u-1")
    // `locked` is its own kind now: the BROADCAST half must still say nothing, but the artifact
    // rides along so the caller can build a clickable entity whose flexpane answers per-viewer.
    expect(d.kind).toBe("locked")
    if (d.kind !== "locked") return
    expect(d.artifact.short_id).toBe(artifact.short_id)
    const json = JSON.stringify(d.blocks)
    expect(json).toContain("private Derive artifact")
    // It links to the bare short id, which the canonical redirect resolves.
    expect(json).toContain(`/artifacts/${artifact.short_id}`)
    expect(json).not.toContain("Q4 plan")
    expect(json).not.toContain("q4-plan")
    // The catch-all runs against the card WITHOUT the short id, which is random and legitimately
    // present (asserted above). Matching /q4/i over the whole card cannot tell a leaked slug from
    // an id that happens to contain those two characters — and CI duly generated `s_4vq40i` and
    // failed a card that leaked nothing. Excising the id keeps the check exact rather than
    // probabilistic; picking a rarer title would only have made the collision less frequent.
    expect(json.split(artifact.short_id).join("")).not.toMatch(/q4/i)
  })

  // A stale or bare-id link is the sharper case: the slug is re-derived from the CURRENT title
  // on every rename, so building the href from the record would add a title the channel never
  // had — even though the pasted URL carried none.
  it("does not add a title the pasted URL never carried", async () => {
    const { deps, artifact } = await setup("unfurl-private-bare", "none")
    const d = await decideUnfurl(deps, `${BASE}/artifacts/${artifact.short_id}`, "u-1")
    expect(d.kind).toBe("locked")
    // Same short-id excision as the card test above — its comment already recorded CI
    // minting `s_4vq40i` and failing a card that leaked nothing, but the fix never
    // reached this sibling, and CI duly minted `s_4qq487` here.
    if (d.kind === "locked")
      expect(JSON.stringify(d.blocks).split(artifact.short_id).join("")).not.toMatch(/q4/i)
  })

  it("skips an artifact the sharer cannot read", async () => {
    const { deps, url } = await setup("unfurl-unreadable", "workspace")
    const d = await decideUnfurl({ ...deps, canRead: async () => false }, url, "u-1")
    expect(d.kind).toBe("skip")
  })

  // Belongs to another Derive workspace: even if the sharer personally has access, it must not
  // render into THIS team's channel.
  it("skips an artifact from a different workspace", async () => {
    const { deps, url } = await setup("unfurl-other-org", "workspace")
    const d = await decideUnfurl({ ...deps, orgId: "some-other-org" }, url, "u-1")
    expect(d.kind).toBe("skip")
  })

  it("skips a URL with a malformed percent escape instead of throwing", async () => {
    // This used to raise URIError out of decodeURIComponent, which runAfterAck swallowed —
    // silently killing every OTHER preview in the same message.
    const { deps } = await setup("unfurl-badescape", "workspace")
    expect(artifactRefFromUrl(BASE, `${BASE}/artifacts/%zz`)).toBe(null)
    expect((await decideUnfurl(deps, `${BASE}/artifacts/100%-done-abc12345`, "u-1")).kind).toBe(
      "skip",
    )
  })

  it("skips a URL that isn't an artifact link", async () => {
    const { deps } = await setup("unfurl-nonartifact", "workspace")
    expect((await decideUnfurl(deps, `${BASE}/pricing`, "u-1")).kind).toBe("skip")
    expect((await decideUnfurl(deps, `${BASE}/artifacts/nope404`, "u-1")).kind).toBe("skip")
  })
})

// WHY A SKIP HAPPENED, WHICH IS THE ONLY THING THAT MAKES ONE DIAGNOSABLE.
//
// Five rungs end in `skip` and the channel shows the same silent nothing for all of them. They
// cannot be told apart afterwards either: a workspace-listed artifact answers an anonymous probe
// exactly as a non-existent one does, so "try the URL yourself" resolves nothing. The reason has
// to be recorded at the moment it is known.

describe("a skip names the rung that caused it", () => {
  const artifactIn = (org: string, over: Partial<ArtifactRecord> = {}) =>
    ({
      id: "a1",
      short_id: "abc12345",
      org_id: org,
      title: "T",
      listed: "workspace",
      link_role: "none",
      workspace_access: "member",
      removed_at: null,
      current_version: 1,
      ...over,
    }) as ArtifactRecord

  const deps = (artifact: ArtifactRecord | null, canRead = true) => ({
    meta: { getByShortId: async () => artifact } as never,
    baseUrl: "https://derive.to",
    orgId: "org-connected",
    canRead: async () => canRead,
  })

  const skipWhy = async (
    d: ReturnType<typeof deps>,
    url = "https://derive.to/artifacts/abc12345",
  ) => (await decideUnfurl(d, url, "u-sharer")) as { kind: string; why?: string }

  it("distinguishes a link that is not ours at all", async () => {
    const r = await skipWhy(deps(artifactIn("org-connected")), "https://example.com/whatever")
    expect(r.kind).toBe("skip")
    expect(r.why).toMatch(/not an artifact link/i)
  })

  it("distinguishes a short id nothing answers to", async () => {
    const r = await skipWhy(deps(null))
    expect(r.why).toMatch(/no artifact/i)
  })

  it("distinguishes a removed artifact from a missing one", async () => {
    const r = await skipWhy(deps(artifactIn("org-connected", { removed_at: "2026-01-01" })))
    expect(r.why).toMatch(/removed/i)
  })

  // The one worth naming most: the link works for the sharer, the channel shows nothing, and
  // nothing about either fact points at the cause.
  it("distinguishes an artifact living in another workspace", async () => {
    const r = await skipWhy(deps(artifactIn("org-elsewhere")))
    expect(r.why).toMatch(/different Derive workspace/i)
  })

  it("distinguishes a sharer without read standing", async () => {
    const r = await skipWhy(deps(artifactIn("org-connected"), false))
    expect(r.why).toMatch(/read standing/i)
  })

  it("gives every rung a distinct reason, or the log cannot tell them apart", async () => {
    const reasons = [
      (await skipWhy(deps(artifactIn("org-connected")), "https://example.com/x")).why,
      (await skipWhy(deps(null))).why,
      (await skipWhy(deps(artifactIn("org-connected", { removed_at: "2026-01-01" })))).why,
      (await skipWhy(deps(artifactIn("org-elsewhere")))).why,
      (await skipWhy(deps(artifactIn("org-connected"), false))).why,
    ]
    expect(new Set(reasons).size).toBe(5)
  })
})
