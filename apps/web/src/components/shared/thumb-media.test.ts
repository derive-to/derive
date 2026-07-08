import { describe, expect, it } from "vitest"
import { thumbMedia } from "./thumb-media"

// Guards the branch the Thumb component uses to pick its media: the static preview
// PNG when available, the live iframe otherwise (and as the error fallback).
describe("thumbMedia", () => {
  it("uses the img when a preview exists and the image has not failed", () => {
    expect(thumbMedia(true, false)).toBe("img")
  })

  it("uses the iframe when there is no preview", () => {
    expect(thumbMedia(false, false)).toBe("iframe")
  })

  it("uses the iframe when hasPreview is omitted", () => {
    expect(thumbMedia(undefined, false)).toBe("iframe")
  })

  it("falls back to the iframe after the preview image errors", () => {
    expect(thumbMedia(true, true)).toBe("iframe")
  })
})
