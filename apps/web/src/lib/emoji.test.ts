import { describe, expect, it } from "vitest"
import { EMOJI, emojifyShortcodes, PICKER_EMOJI } from "./emoji"

describe("emojifyShortcodes", () => {
  it("replaces known shortcodes with their emoji", () => {
    expect(emojifyShortcodes(":goat:")).toBe("🐐")
    expect(emojifyShortcodes("ship it :rocket:")).toBe("ship it 🚀")
    expect(emojifyShortcodes(":+1: :tada:")).toBe("👍 🎉")
  })

  it("is case-insensitive on the code", () => {
    expect(emojifyShortcodes(":TADA:")).toBe("🎉")
  })

  it("leaves unknown shortcodes untouched", () => {
    expect(emojifyShortcodes("ping :devonta_smith:")).toBe("ping :devonta_smith:")
    expect(emojifyShortcodes("a 3:30 ratio")).toBe("a 3:30 ratio")
  })

  it("only the picker set maps to real emoji entries", () => {
    expect(PICKER_EMOJI.length).toBeGreaterThan(0)
    // every picker glyph is a value present in the shortcode map (so typing the
    // code and tapping the picker agree).
    const chars = new Set(Object.values(EMOJI))
    for (const e of PICKER_EMOJI) expect(chars.has(e)).toBe(true)
  })
})
