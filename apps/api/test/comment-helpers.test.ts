import type { CommentRecord } from "@dock/core"
import { describe, expect, it } from "vitest"
import {
  commentJson,
  MAX_MENTIONS,
  parseMentions,
  parseMeta,
  previewOf,
  quoteOf,
} from "../src/lib/comments"

describe("parseMentions — defensive against bad clients", () => {
  it("returns [] for anything that isn't an array", () => {
    for (const bad of [null, undefined, "x", 5, {}, true]) expect(parseMentions(bad)).toEqual([])
  })

  it("requires a non-empty string id and a string name (an empty name is allowed)", () => {
    const input = [
      null,
      "nope",
      { id: "no-name" }, // name missing -> rejected
      { name: "no-id" }, // id missing -> rejected
      { id: "", name: "empty-id" }, // empty id -> rejected
      { id: 7, name: "num-id" }, // non-string id -> rejected
      { id: "u1", name: "" }, // empty NAME is allowed; id is the key that matters
      { id: "u2", name: "Valid" },
    ]
    expect(parseMentions(input)).toEqual([
      { id: "u1", name: "" },
      { id: "u2", name: "Valid" },
    ])
  })

  it("dedupes by id, keeping the first occurrence, and preserves order", () => {
    const input = [
      { id: "a", name: "Ana" },
      { id: "b", name: "Bo" },
      { id: "a", name: "Ana again" },
    ]
    expect(parseMentions(input)).toEqual([
      { id: "a", name: "Ana" },
      { id: "b", name: "Bo" },
    ])
  })

  it("caps the result at MAX_MENTIONS distinct mentions", () => {
    const input = Array.from({ length: MAX_MENTIONS + 25 }, (_, i) => ({
      id: `u${i}`,
      name: `n${i}`,
    }))
    expect(parseMentions(input)).toHaveLength(MAX_MENTIONS)
  })
})

describe("quoteOf — anchor quote extraction", () => {
  it("returns the anchor's exact text", () => {
    expect(quoteOf(JSON.stringify({ type: "TextQuoteSelector", exact: "the headline" }))).toBe(
      "the headline",
    )
  })

  it("returns null for a null, malformed, or exact-less anchor", () => {
    expect(quoteOf(null)).toBeNull()
    expect(quoteOf("{not json")).toBeNull()
    expect(quoteOf(JSON.stringify({ type: "TextQuoteSelector" }))).toBeNull()
  })
})

describe("previewOf — single-line notification preview", () => {
  it("collapses whitespace and trims", () => {
    expect(previewOf("  the\nquick \t brown   fox  ")).toBe("the quick brown fox")
  })

  it("leaves a short body intact, including at the 160-char boundary", () => {
    const exactly160 = "x".repeat(160)
    expect(previewOf(exactly160)).toBe(exactly160)
  })

  it("truncates a long body to 159 chars plus an ellipsis", () => {
    const preview = previewOf("y".repeat(200))
    expect(preview).toHaveLength(160)
    expect(preview.endsWith("…")).toBe(true)
    expect(preview.slice(0, -1)).toBe("y".repeat(159))
  })
})

describe("parseMeta", () => {
  it("returns {} for null or malformed JSON, and the parsed object otherwise", () => {
    expect(parseMeta(null)).toEqual({})
    expect(parseMeta("{oops")).toEqual({})
    expect(parseMeta(JSON.stringify({ edited_at: "t", deleted: true }))).toEqual({
      edited_at: "t",
      deleted: true,
    })
  })
})

const cm = (over: Partial<CommentRecord> = {}): CommentRecord => ({
  id: "c1",
  artifact_id: "a1",
  thread_id: "t1",
  base_version: 1,
  path: null,
  anchor: null,
  body_md: "hello there",
  author: "jess",
  author_id: "u1",
  state: "open",
  visibility: "public",
  owner_id: null,
  created_at: "2026-01-01T00:00:00.000Z",
  meta: null,
  ...over,
})

describe("commentJson — wire shape", () => {
  it("drops the raw meta blob and surfaces clean defaults", () => {
    const out = commentJson(cm())
    expect(out).not.toHaveProperty("meta")
    expect(out.body_md).toBe("hello there")
    expect(out.reactions).toEqual({})
    expect(out.edited).toBe(false)
    expect(out.edited_at).toBeNull()
    expect(out.deleted).toBe(false)
    expect(out.mentions).toEqual([])
    expect(out).not.toHaveProperty("anchored")
  })

  it("unpacks reactions, edited, and mentions from meta", () => {
    const out = commentJson(
      cm({
        meta: JSON.stringify({
          reactions: { "👍": ["u2"] },
          edited_at: "2026-01-02T00:00:00.000Z",
          mentions: [{ id: "u9", name: "Sky" }],
        }),
      }),
    )
    expect(out.reactions).toEqual({ "👍": ["u2"] })
    expect(out.edited).toBe(true)
    expect(out.edited_at).toBe("2026-01-02T00:00:00.000Z")
    expect(out.mentions).toEqual([{ id: "u9", name: "Sky" }])
  })

  it("blanks the body and mentions of a deleted comment (no content leak)", () => {
    const out = commentJson(
      cm({
        body_md: "secret content",
        meta: JSON.stringify({ deleted: true, mentions: [{ id: "u9", name: "Sky" }] }),
      }),
    )
    expect(out.deleted).toBe(true)
    expect(out.body_md).toBe("")
    expect(out.mentions).toEqual([])
  })

  it("includes the anchored flag only when it is passed", () => {
    expect(commentJson(cm(), true).anchored).toBe(true)
    expect(commentJson(cm(), false).anchored).toBe(false)
    expect(commentJson(cm())).not.toHaveProperty("anchored")
  })
})
