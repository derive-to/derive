// The shell's colours, mirroring the two --background canvases and the ink tokens in
// apps/web/src/styles/globals.css.
//
// Deliberately a plain object rather than NativeWind: NativeWind v4 (the production
// release) targets Tailwind v3, and apps/web is on Tailwind v4. NativeWind v5 is the
// release that aligns with v4 and is still a preview. Taking a preview styling
// toolchain as a dependency to share class names across two surfaces, when what
// actually has to match is a handful of colour values, is a bad trade. Keep this file
// in step with globals.css by hand; it is short on purpose.
export const tokens = {
  light: {
    background: "#f7f8fa",
    foreground: "#14161a",
    muted: "#5c616b",
    border: "#e5e7eb",
    card: "#ffffff",
  },
  dark: {
    background: "#0a0b0d",
    foreground: "#e9ebef",
    muted: "#9aa0aa",
    border: "#262a31",
    card: "#101216",
  },
} as const

export type Scheme = keyof typeof tokens
export type Tokens = (typeof tokens)[Scheme]

/** Envelope for the page telling the shell what colour it is actually painting. */
export const BACKGROUND_MESSAGE = "background"

/**
 * Reports the page's REAL background colour to the shell, and again whenever it changes.
 *
 * The safe-area strip above the web view has to match the page, and the device's colour
 * scheme is the wrong thing to ask: the web app resolves its own theme (a stored choice
 * first, the OS only as a fallback), so a phone in light mode showing a dark-themed app
 * gave a white band above black chrome. The page is the only honest source.
 *
 * Reads the computed background rather than a token name, so it stays right whatever the
 * theme system does next. The observer catches the in-app theme toggle, which changes a
 * class on <html> without any navigation for the shell to hook.
 */
export const BACKGROUND_PROBE = `
(function () {
  var post = function () {
    try {
      var el = document.body || document.documentElement
      var bg = getComputedStyle(el).backgroundColor
      // A transparent body means the colour lives on <html>; ask that instead.
      if (!bg || bg === "transparent" || bg === "rgba(0, 0, 0, 0)") {
        bg = getComputedStyle(document.documentElement).backgroundColor
      }
      window.ReactNativeWebView && window.ReactNativeWebView.postMessage(
        JSON.stringify({ type: ${JSON.stringify(BACKGROUND_MESSAGE)}, color: bg })
      )
    } catch (e) {}
  }
  post()
  // The theme toggle swaps a class on <html>; there is no navigation to key off.
  try {
    new MutationObserver(post).observe(document.documentElement, {
      attributes: true, attributeFilter: ["class", "style", "data-theme"]
    })
  } catch (e) {}
  // The OS-appearance path resolves after first paint on some loads.
  try { matchMedia("(prefers-color-scheme: dark)").addEventListener("change", post) } catch (e) {}
})();
true;
`
