import { type ArtifactRecord, newId, type UnfurlInfo } from "@derive/core"
import { describe, expect, it } from "vitest"
import type { ArtifactStatus } from "../src/lib/artifact-status"
import { artifactRefFromUrl, decideUnfurl } from "../src/lib/slack-unfurl"
import {
  artifactDetails,
  artifactEntity,
  commentThreadEntity,
  decodeReviewAction,
  encodeReviewAction,
  SLACK_REVIEW_ACTION,
} from "../src/lib/slack-work-object"
import { quotaApp } from "./helpers"

const BASE = "https://derive.test"

describe("artifactRefFromUrl", () => {
  it("reads the ref out of a share URL on this instance", () => {
    expect(artifactRefFromUrl(BASE, `${BASE}/artifacts/spec-abc123`)).toBe("spec-abc123")
    expect(artifactRefFromUrl(BASE, `${BASE}/artifacts/abc123/`)).toBe("abc123")
    expect(artifactRefFromUrl(BASE, `${BASE}/artifacts/spec-abc123?comment=t1`)).toBe("spec-abc123")
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
  // The broadcast gate is ACCESS, not discovery: locked means the artifact grants the
  // workspace nothing AND is unlisted. The default team draft (workspace_access=member,
  // listed=none) broadcasts; a link-only draft does not — a link role is personal to
  // whoever holds the URL, so `link_role: "viewer"` rides along on the locked fixtures
  // to pin that it never unlocks one.
  const setup = async (
    name: string,
    access: { workspace_access: "none" | "member"; listed: "none" | "workspace" },
  ) => {
    const { meta } = quotaApp(name, { defaultOrgId: "default" }, [], [])
    const artifact = (await meta.createArtifact({
      id: newId("a"),
      short_id: newId("s").slice(0, 8),
      org_id: "default",
      slug: null,
      title: "Q4 plan",
      workspace_access: access.workspace_access,
      link_role: "viewer",
      listed: access.listed,
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
  const TEAM = { workspace_access: "member", listed: "workspace" } as const
  const DRAFT = { workspace_access: "member", listed: "none" } as const
  const LINK_ONLY = { workspace_access: "none", listed: "none" } as const

  // Without an account link there is no principal to authorize, so Slack's own sign-in prompt
  // is the answer — it is also the only per-person surface chat.unfurl offers.
  it("asks an unlinked sharer to connect", async () => {
    const { deps, url } = await setup("unfurl-unlinked", TEAM)
    expect((await decideUnfurl(deps, url, null)).kind).toBe("auth")
  })

  it("renders a card for a feed-visible artifact", async () => {
    const { deps, url } = await setup("unfurl-listed", TEAM)
    const d = await decideUnfurl(deps, url, "u-1")
    expect(d.kind).toBe("card")
    if (d.kind === "card") expect(JSON.stringify(d.blocks)).toContain("Q4 plan")
  })

  // The default publish shape: workspace members may read it, it just isn't in the library
  // feed. `listed` is discovery-only and carries no access, so it must not be what decides a
  // broadcast into the workspace's own Slack — every member of the audience may already open it.
  it("renders a card for a team draft — workspace access broadcasts, unlisted or not", async () => {
    const { deps, url } = await setup("unfurl-draft", DRAFT)
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
    const { deps, url, artifact } = await setup("unfurl-private", LINK_ONLY)
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
    const { deps, artifact } = await setup("unfurl-private-bare", LINK_ONLY)
    const d = await decideUnfurl(deps, `${BASE}/artifacts/${artifact.short_id}`, "u-1")
    expect(d.kind).toBe("locked")
    // Same short-id excision as the card test above — its comment already recorded CI
    // minting `s_4vq40i` and failing a card that leaked nothing, but the fix never
    // reached this sibling, and CI duly minted `s_4qq487` here.
    if (d.kind === "locked")
      expect(JSON.stringify(d.blocks).split(artifact.short_id).join("")).not.toMatch(/q4/i)
  })

  it("skips an artifact the sharer cannot read", async () => {
    const { deps, url } = await setup("unfurl-unreadable", TEAM)
    const d = await decideUnfurl({ ...deps, canRead: async () => false }, url, "u-1")
    expect(d.kind).toBe("skip")
  })

  // Belongs to another Derive workspace: even if the sharer personally has access, it must not
  // render into THIS team's channel.
  it("skips an artifact from a different workspace", async () => {
    const { deps, url } = await setup("unfurl-other-org", TEAM)
    const d = await decideUnfurl({ ...deps, orgId: "some-other-org" }, url, "u-1")
    expect(d.kind).toBe("skip")
  })

  it("skips a URL with a malformed percent escape instead of throwing", async () => {
    // This used to raise URIError out of decodeURIComponent, which runAfterAck swallowed —
    // silently killing every OTHER preview in the same message.
    const { deps } = await setup("unfurl-badescape", TEAM)
    expect(artifactRefFromUrl(BASE, `${BASE}/artifacts/%zz`)).toBe(null)
    expect((await decideUnfurl(deps, `${BASE}/artifacts/100%-done-abc12345`, "u-1")).kind).toBe(
      "skip",
    )
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

// What the entity pins: the stable short_id key, alt_text on every image, no preview for a
// non-public artifact, review buttons only while a round is pending, and decodeReviewAction
// tolerating garbage.
describe("the Work Object entity the unfurl hands Slack", () => {
  const artifact = (over: Partial<ArtifactRecord> = {}) =>
    ({
      id: "a1",
      short_id: "abc123",
      org_id: "default",
      title: "Q4 plan",
      listed: "workspace",
      current_version: 3,
      updated_at: "2026-08-01T10:00:00.000Z",
      ...over,
    }) as ArtifactRecord

  const info: UnfurlInfo = {
    title: "Q4 plan",
    kindLabel: "Doc",
    versionCount: 3,
    commentCount: 7,
    pageUrl: "https://derive.to/artifacts/q4-plan-abc123",
    imageUrl: "https://derive.to/v1/og/abc123",
    oembedUrl: "x",
    embedUrl: "y",
    markdownUrl: "z",
  }

  const status = (over: Partial<ArtifactStatus> = {}): ArtifactStatus => ({
    review: null,
    openThreads: 0,
    updatedAt: "2026-08-01T10:00:00.000Z",
    lastModifiedBy: "Dana",
    previewReady: true,
    ...over,
  })

  const base = {
    pastedUrl: "https://derive.to/artifacts/q4-plan-abc123",
    iconUrl: "https://d/i.png",
  }

  describe("artifactEntity", () => {
    // external_ref is the key Slack stores for search and related-conversation aggregation. It has
    // to be the STABLE short id — a slug is re-derived on every rename, which would orphan every
    // previously-unfurled card from its history.
    it("keys on the stable short id, never a slug", () => {
      const e = artifactEntity({ ...base, artifact: artifact(), info, status: status() })
      expect(e.external_ref).toEqual({ id: "abc123", type: "artifact" })
      expect(e.entity_type).toBe("slack#/entities/content_item")
      // The pasted URL is how Slack matches the unfurl back to the message; it is NOT the
      // canonical url, and swapping them silently unfurls nothing.
      expect(e.app_unfurl_url).toBe(base.pastedUrl)
      expect(e.url).toBe(info.pageUrl)
    })

    // A missing alt_text is this API's documented silent failure: 200 OK, a buried warning, and an
    // empty channel. Every image we emit must carry one.
    it("gives every image an alt_text", () => {
      const e = artifactEntity({
        ...base,
        artifact: artifact({ listed: "public" }),
        info,
        status: status(),
        previewUrl: info.imageUrl,
      })
      const attrs = (e.entity_payload as { attributes: Record<string, never> }).attributes
      expect(attrs.product_icon).toMatchObject({ alt_text: expect.any(String) })
      // And no alt_text anywhere is present-but-empty, which Slack treats the same as missing.
      const walk = (v: unknown): void => {
        if (Array.isArray(v)) return void v.forEach(walk)
        if (v && typeof v === "object") {
          const o = v as Record<string, unknown>
          if ("alt_text" in o) expect(String(o.alt_text).length).toBeGreaterThan(0)
          Object.values(o).forEach(walk)
        }
      }
      walk(e)
    })

    // Buttons ride the BROADCAST card, so they appear only when there is something to settle.
    it("offers review buttons only while a round is pending", () => {
      const withRound = artifactEntity({
        ...base,
        artifact: artifact(),
        info,
        status: status({ review: { state: "pending", reviewerId: "u", reviewerName: "M" } }),
        withActions: true,
      })
      const actions = (withRound.entity_payload as { actions?: unknown }).actions as {
        primary_actions: { action_id: string }[]
      }
      expect(actions.primary_actions.map((a) => a.action_id)).toEqual([
        SLACK_REVIEW_ACTION.sendBack,
      ])
      const settled = artifactEntity({ ...base, artifact: artifact(), info, status: status() })
      expect((settled.entity_payload as Record<string, never>).actions).toBeUndefined()
    })

    // Slack fetches preview images ANONYMOUSLY, and /v1/og answers an anonymous fetch by link
    // role — so a workspace-only artifact would render the title-less padlock as its picture.
    it("carries a preview for a public artifact and none for a workspace one", () => {
      const pub = artifactEntity({
        ...base,
        artifact: artifact({ listed: "public" }),
        info,
        status: status(),
        previewUrl: info.imageUrl,
      })
      expect((pub.entity_payload as Record<string, never>).attributes).toHaveProperty(
        "full_size_preview",
      )
      const ws = artifactEntity({ ...base, artifact: artifact(), info, status: status() })
      expect((ws.entity_payload as Record<string, never>).attributes).not.toHaveProperty(
        "full_size_preview",
      )
    })
  })

  describe("commentThreadEntity", () => {
    it("puts a thread target on Reply as well as its Work Object external ref", () => {
      const entity = commentThreadEntity({
        baseUrl: "https://derive.test",
        artifact: artifact(),
        comment: {
          thread_id: "c_thread",
          body_md: "Which direction should we take?",
          author: "Derive",
          state: "open",
        },
        iconUrl: "https://derive.test/icon.png",
      })
      expect(entity.external_ref).toEqual({ id: "c_thread", type: "comment_thread" })
      const action = (
        entity.entity_payload as { actions: { primary_actions: Array<Record<string, unknown>> } }
      ).actions.primary_actions[0]
      if (!action) throw new Error("Reply action missing")
      expect(action.action_id).toBe("derive_question_reply")
      expect(action.value).toBe(JSON.stringify({ artifactId: "a1", threadId: "c_thread" }))
    })
  })

  describe("artifactDetails (the flexpane)", () => {
    // Opening a flexpane UPDATES the card from the metadata the app answers with — Slack: "the
    // unfurl will also be updated given the entity metadata that has changed". So a details
    // payload that omitted the actions would silently strip Approve and Send back from a card
    // that had them, and the only symptom would be buttons quietly disappearing after a click.
    it("carries the same actions as the card, so opening it cannot strip them", () => {
      const pending = status({
        review: { state: "pending", reviewerId: "u-me", reviewerName: "Mert" },
      })
      const card = artifactEntity({
        ...base,
        artifact: artifact(),
        info,
        status: pending,
        withActions: true,
      })
      const pane = artifactDetails(artifact(), info, pending, "u-me", "https://d/i.png")
      const ids = (p: Record<string, unknown>) =>
        (
          (p.actions as { primary_actions?: { action_id: string }[] } | undefined)
            ?.primary_actions ?? []
        ).map((x) => x.action_id)
      expect(ids(pane.entity_payload as Record<string, unknown>)).toEqual(
        ids(card.entity_payload as Record<string, unknown>),
      )
      expect(ids(pane.entity_payload as Record<string, unknown>)).toHaveLength(1)
    })

    // entity.presentDetails answers invalid_arguments without these — "missing required field:
    // external_ref [json-pointer:/metadata]". The flexpane must say WHICH entity it describes;
    // Slack does not infer it from the trigger. The pair must match the unfurl's, since it keys
    // search and the Conversations tab.
    it("identifies the entity, which presentDetails requires", () => {
      const d = artifactDetails(artifact(), info, status(), "u", "https://d/i.png")
      expect(d.url).toBe(info.pageUrl)
      expect(d.external_ref).toEqual({ id: "abc123", type: "artifact" })
      const card = artifactEntity({ ...base, artifact: artifact(), info, status: status() })
      expect(d.external_ref).toEqual(card.external_ref)
    })
  })

  // The same two actions now ride three surfaces: the Work Object card, the review-request DM and
  // the channel card. Only the first gets an entity echoed back by Slack, so every button carries
  // its target in `value` as well — one mechanism to get right instead of two, and the handler
  // never depends on Slack round-tripping an entity to know what was clicked.
  describe("review buttons target the artifact from any surface", () => {
    it("round-trips the artifact id", () => {
      expect(decodeReviewAction(encodeReviewAction("a_123"))).toBe("a_123")
    })

    // The value only NAMES the target; runSlackReviewAction re-reads and re-authorizes. A forged
    // one can at worst point at a doc the clicker still cannot act on.
    it("returns null for a malformed or empty value rather than throwing", () => {
      for (const bad of ["", "{", "null", '{"a":""}', '{"b":"x"}'])
        expect(decodeReviewAction(bad)).toBeNull()
    })
  })

  // THE PICTURE, AND WHO TOUCHED IT LAST.
  //
  // `content_item` recognises exactly six typed fields, established against the live API rather
  // than from the docs alone — the discriminator being that Slack SHAPE-CHECKS a field it knows
  // and silently swallows one it does not. A malformed `preview` names itself in the error; a
  // malformed `assignee` (which belongs to `task`) produces nothing at all.

  describe("the card's own image", () => {
    it("carries the thumbnail as a typed field, with the alt_text Slack demands", () => {
      const e = artifactEntity({
        ...base,
        artifact: artifact(),
        info,
        status: status(),
        previewUrl: "https://d/p.png",
      })
      const preview = (e.entity_payload as { fields: Record<string, Record<string, unknown>> })
        .fields.preview
      expect(preview?.type).toBe("slack#/types/image")
      expect(preview?.image_url).toBe("https://d/p.png")
      // Omitting alt_text fails the whole payload with a pointer at this field — verified.
      expect(preview?.alt_text).toBeTruthy()
    })
  })
})
