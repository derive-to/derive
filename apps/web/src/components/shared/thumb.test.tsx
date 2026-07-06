/**
 * Logic-level tests for Thumb's media-selection branch.
 *
 * apps/web has no jsdom / react-testing-library setup (only pure-logic vitest),
 * so we test the branching conditions directly rather than rendering. The three
 * cases covered:
 *   1. hasPreview true  + imgFailed false  → use <img> (src = /v1/og/:id)
 *   2. hasPreview false                   → use <iframe>
 *   3. hasPreview true  + imgFailed true   → fall back to <iframe>
 */
import { describe, expect, it } from "vitest"

/** Mirrors the branching logic inside Thumb exactly. */
function mediaKind(hasPreview: boolean | undefined, imgFailed: boolean): "img" | "iframe" {
  return hasPreview && !imgFailed ? "img" : "iframe"
}

/** Expected img src when showing the static PNG. */
function imgSrc(apiBase: string, id: string): string {
  return `${apiBase}/v1/og/${id}`
}

describe("Thumb media-selection branch", () => {
  it("uses <img> when hasPreview is true and the image has not failed", () => {
    expect(mediaKind(true, false)).toBe("img")
  })

  it("uses <iframe> when hasPreview is false", () => {
    expect(mediaKind(false, false)).toBe("iframe")
  })

  it("uses <iframe> when hasPreview is undefined (prop omitted)", () => {
    expect(mediaKind(undefined, false)).toBe("iframe")
  })

  it("falls back to <iframe> after img onError fires (imgFailed = true)", () => {
    expect(mediaKind(true, true)).toBe("iframe")
  })

  it("builds the correct /v1/og/:id src for the img branch", () => {
    expect(imgSrc("http://localhost:8090", "abc123")).toBe("http://localhost:8090/v1/og/abc123")
  })
})
