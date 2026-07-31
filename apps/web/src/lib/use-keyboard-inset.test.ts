import { describe, expect, it } from "vitest"
import { KEYBOARD_MIN_INSET, keyboardInsetFrom } from "./use-keyboard-inset"

// The arithmetic behind "is the keyboard up, and how much does it cover" — the
// number the mobile comments sheet pins itself above, and the number inline editing
// gives back to the document so the line under the caret isn't behind the keyboard.
// A real virtual keyboard can't be summoned in a headless browser, so the threshold
// rule is pinned here instead of discovered on a device.
describe("keyboardInsetFrom", () => {
  it("reports nothing when the visual viewport fills the layout viewport", () => {
    expect(keyboardInsetFrom(844, 844, 0)).toBeNull()
  })

  it("reports the covered height when a keyboard is up", () => {
    // iPhone 14: 844pt layout, ~336pt keyboard.
    expect(keyboardInsetFrom(844, 508, 0)).toEqual({ inset: 336, height: 508 })
  })

  it("ignores Safari's toolbar collapse, which looks like a small keyboard", () => {
    // The ~60-115px shrink when the URL bar collapses must NOT pin the layout.
    expect(keyboardInsetFrom(844, 784, 0)).toBeNull() // 60px
    expect(keyboardInsetFrom(844, 729, 0)).toBeNull() // 115px
    expect(keyboardInsetFrom(844, 844 - KEYBOARD_MIN_INSET, 0)).toBeNull() // exactly at the line
    expect(keyboardInsetFrom(844, 844 - KEYBOARD_MIN_INSET - 1, 0)).not.toBeNull() // just past it
  })

  it("accounts for a scrolled visual viewport (offsetTop)", () => {
    // Pinch-zoomed or scrolled: the visible band is offset from the layout top, and
    // ignoring that would overstate what the keyboard covers.
    expect(keyboardInsetFrom(844, 500, 100)).toEqual({ inset: 244, height: 500 })
  })

  it("never reports a negative inset when the visual viewport exceeds the layout", () => {
    expect(keyboardInsetFrom(800, 900, 0)).toBeNull()
  })

  it("rounds to whole pixels (visualViewport reports fractions)", () => {
    expect(keyboardInsetFrom(844, 507.6, 0)).toEqual({ inset: 336, height: 508 })
  })
})
