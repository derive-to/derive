import type { ArtifactRecord, UnfurlInfo } from "@derive/core"
import { describe, expect, it } from "vitest"
import { type ArtifactStatus, agoLabel, statusPhrase } from "../src/lib/artifact-status"
import { SLACK_SUBSCRIBABLE_EVENTS } from "../src/lib/slack-subscriptions"
import { artifactDetails, artifactEntity, SLACK_REVIEW_ACTION } from "../src/lib/slack-work-object"

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
}

const status = (over: Partial<ArtifactStatus> = {}): ArtifactStatus => ({
  review: null,
  openThreads: 0,
  updatedAt: "2026-08-01T10:00:00.000Z",
  ...over,
})

const base = { pastedUrl: "https://derive.to/artifacts/q4-plan-abc123", iconUrl: "https://d/i.png" }

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

  it("leads with the review state as a coloured status tag", () => {
    const e = artifactEntity({
      ...base,
      artifact: artifact(),
      info,
      status: status({
        review: { state: "pending", reviewerId: "u-mert", reviewerName: "Mert" },
        openThreads: 2,
      }),
      withActions: true,
    })
    const p = e.entity_payload as { fields: Record<string, never>; custom_fields: unknown[] }
    // content_item accepts exactly five typed fields and silently DROPS the rest — `status` and
    // `assignee` belong to `task`. Measured against the live API: sending them returns
    // "The field status will be omitted due to an invalid type". So the review state rides
    // custom_fields, and only `description` / `date_updated` go in `fields`.
    expect(Object.keys(p.fields).sort()).toEqual(["date_updated", "description"])
    expect(p.fields.description).toMatchObject({ format: "markdown" })
    expect(JSON.stringify(p.fields)).not.toContain("tag_color")
    const cf = JSON.stringify(p.custom_fields)
    expect(cf).toContain("Awaiting review")
    expect(cf).toContain("Mert")
    expect(cf).toContain("Open threads")
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
      SLACK_REVIEW_ACTION.approve,
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
        (p.actions as { primary_actions?: { action_id: string }[] } | undefined)?.primary_actions ??
        []
      ).map((x) => x.action_id)
    expect(ids(pane.entity_payload as Record<string, unknown>)).toEqual(
      ids(card.entity_payload as Record<string, unknown>),
    )
    expect(ids(pane.entity_payload as Record<string, unknown>)).toHaveLength(2)
  })

  it("offers no actions once the round is settled", () => {
    const pane = artifactDetails(artifact(), info, status(), "u-me", "https://d/i.png")
    expect((pane.entity_payload as Record<string, unknown>).actions).toBeUndefined()
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

  it("describes the artifact for a viewer entitled to it, and says 'your review'", () => {
    const d = artifactDetails(
      artifact(),
      info,
      status({ review: { state: "pending", reviewerId: "u-me", reviewerName: "Mert" } }),
      "u-me",
      "https://d/i.png",
    )
    expect(JSON.stringify(d)).toContain("Q4 plan")
    const f = (d.entity_payload as { fields: Record<string, never> }).fields
    // Only content_item's own field names, and markdown — "plain_text" is not in the enum and
    // rejects the entire payload.
    expect(Object.keys(f)).toEqual(["description"])
    expect(f.description).toMatchObject({ format: "markdown" })
    expect(JSON.stringify(f.description)).toContain("Awaiting your review")
  })
})

describe("statusPhrase", () => {
  // The single most clickable word on the card: "your".
  it("says 'your review' to the reviewer and names them to everyone else", () => {
    const s = status({ review: { state: "pending", reviewerId: "u-mert", reviewerName: "Mert" } })
    expect(statusPhrase(s, "u-mert")?.text).toBe("Awaiting your review")
    expect(statusPhrase(s, "u-other")).toEqual({
      text: "Awaiting review from",
      reviewerName: "Mert",
    })
  })

  it("is null when nothing is pending, so callers fall back to the description", () => {
    expect(statusPhrase(status(), "u")).toBeNull()
  })
})

describe("agoLabel", () => {
  const now = Date.parse("2026-08-01T12:00:00.000Z")
  it("is coarse on purpose — the question is 'still current', not 'what minute'", () => {
    expect(agoLabel("2026-08-01T11:59:30.000Z", now)).toBe("just now")
    expect(agoLabel("2026-08-01T10:00:00.000Z", now)).toBe("2h ago")
    expect(agoLabel("2026-07-20T12:00:00.000Z", now)).toBe("12d ago")
    expect(agoLabel("2026-02-01T12:00:00.000Z", now)).toBe("6mo ago")
  })
  it("survives a null or unparseable timestamp", () => {
    expect(agoLabel(null, now)).toBeNull()
    expect(agoLabel("not a date", now)).toBeNull()
  })
})

// The loop's most decision-relevant moment. These reached the reviewer's DM but no CHANNEL could
// hear that a doc was blocked on someone — the fact a team most wants ambient.
describe("review events are channel-subscribable", () => {
  it("offers the review round alongside publishes and proposals", () => {
    for (const e of ["review.requested", "review.sent_back", "review.approved"])
      expect(SLACK_SUBSCRIBABLE_EVENTS).toContain(e)
  })
})
