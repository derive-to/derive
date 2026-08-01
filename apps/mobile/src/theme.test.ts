import { beforeEach, describe, expect, it } from "vitest"
import { BACKGROUND_MESSAGE, BACKGROUND_PROBE, tokens } from "./theme"

// The safe-area strip above the web view has to match the PAGE. Getting that wrong is not
// cosmetic: it produced a grey band on the first attempt and a white-on-black one on the
// second, both visible on launch. The probe is the mechanism, and it runs as an injected
// script inside a document — so it is exercised here in one, rather than only on a phone.

/** Run the probe the way the web view does, and return whatever it posted. */
const runProbe = (): { type?: string; color?: string } | null => {
  let posted: string | null = null
  // biome-ignore lint/suspicious/noExplicitAny: standing in for the web view's injected global.
  ;(window as any).ReactNativeWebView = {
    postMessage: (m: string) => {
      posted = m
    },
  }
  // biome-ignore lint/security/noGlobalEval: the point of the test is to run the real script.
  eval(BACKGROUND_PROBE)
  return posted ? JSON.parse(posted) : null
}

beforeEach(() => {
  document.body.removeAttribute("style")
  document.documentElement.removeAttribute("style")
})

describe("BACKGROUND_PROBE", () => {
  it("reports the page's background under the agreed envelope", () => {
    document.body.style.backgroundColor = "rgb(10, 11, 13)"
    const msg = runProbe()
    expect(msg?.type).toBe(BACKGROUND_MESSAGE)
    expect(msg?.color).toBe("rgb(10, 11, 13)")
  })

  it("reports light and dark differently, which is the whole job", () => {
    document.body.style.backgroundColor = "rgb(247, 248, 250)"
    expect(runProbe()?.color).toBe("rgb(247, 248, 250)")
    document.body.style.backgroundColor = "rgb(10, 11, 13)"
    expect(runProbe()?.color).toBe("rgb(10, 11, 13)")
  })

  it("falls through to <html> when the body is transparent", () => {
    // A transparent body means the colour lives on the root; reading the body alone would
    // report rgba(0,0,0,0) and paint the strip see-through.
    document.documentElement.style.backgroundColor = "rgb(5, 5, 5)"
    expect(runProbe()?.color).toBe("rgb(5, 5, 5)")
  })

  it("never throws, whatever the document looks like", () => {
    // It is injected into a page the shell does not control, so a throw here would take
    // out whatever else the injection is doing.
    expect(() => runProbe()).not.toThrow()
  })
})

describe("tokens", () => {
  it("carries the two canvases the strip falls back to before the page reports", () => {
    // Mirrored by hand from apps/web/src/styles/globals.css; these are the values the
    // probe was verified to report for each stored theme.
    expect(tokens.dark.background).toBe("#0a0b0d")
    expect(tokens.light.background).toBe("#f7f8fa")
  })
})
