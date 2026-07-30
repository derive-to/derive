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
  it("renders a title-less locked card for a private artifact", async () => {
    const { deps, url } = await setup("unfurl-private", "none")
    const d = await decideUnfurl(deps, url, "u-1")
    expect(d.kind).toBe("card")
    if (d.kind === "card") {
      expect(JSON.stringify(d.blocks)).not.toContain("Q4 plan")
      expect(JSON.stringify(d.blocks)).toContain("private Derive artifact")
    }
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

  it("skips a URL that isn't an artifact link", async () => {
    const { deps } = await setup("unfurl-nonartifact", "workspace")
    expect((await decideUnfurl(deps, `${BASE}/pricing`, "u-1")).kind).toBe("skip")
    expect((await decideUnfurl(deps, `${BASE}/artifacts/nope404`, "u-1")).kind).toBe("skip")
  })
})
