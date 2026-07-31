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
