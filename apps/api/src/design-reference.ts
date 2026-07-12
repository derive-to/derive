/**
 * The design reference — the static MCP resource behind styled-artifact authoring
 * (`derive://design/reference`). The Brandprint profile carries a workspace's values
 * (colors, type, radii — the tokens island); this carries the method: how to turn
 * values into a page that reads as designed rather than generated. Derive never runs
 * inference; the guidance is versioned like code and the user's own agent applies it.
 * A pure leaf: no imports, safe in every build (worker + node).
 *
 * Plan: docs/plans/agent-artifact-learnings.md §5. Teams that want to tune these
 * rules fork them as a workspace skill (a bundle with a SKILL.md), which surfaces at
 * connect like any Brandprint convention and takes precedence per the usual chain.
 */

export const DESIGN_REFERENCE = `# Designing a styled artifact

You are about to publish a fully-styled HTML page. It will render exactly as you
author it, in a sandboxed viewer, to humans who will judge it the way they judge any
page: in the first second, by its composition. This is the method. If this workspace
has a Brandprint profile (\`derive://brandprint/profile\`), that is the palette,
type, and voice — read it first and use its tokens island; your personal Brandprint
outranks the workspace's, and both outrank the defaults below.

## Calibrate the treatment before writing a line

Most pages are **working documents** — a plan, a review, a report, a dashboard. They
deserve real craft: a type scale, considered spacing, a chosen palette. They do not
deserve a hero section, a scroll animation, or a visual identity. Over-designing a
memo reads as not knowing what a memo is.

Some pages are **editorial** — a landing page, a launch page, a mock the team will
judge as a product surface. There, open with the most characteristic thing in the
subject's world and take one deliberate aesthetic risk in one place, keeping
everything around it quiet.

When unsure, err utilitarian: a well-composed document is never wrong; an
over-designed one often is.

## Type carries the page

- Two roles, chosen deliberately: a display face with character for headings, a
  complementary body face for reading. Naming the same one or two "safe" sans faces
  every time is how generated pages get spotted.
- Set a scale and stay on it. Running text near 65 characters per line. Headings get
  \`text-wrap: balance\`; uppercase labels get letter-spacing; columns of digits get
  \`font-variant-numeric: tabular-nums\`.
- Fonts are binaries: upload woff2 to \`POST /v1/assets\` and reference the URL in
  \`@font-face\` — never base64 through a tool call (one mistranscribed character
  breaks a font silently).

## Color is a token system, not a decoration

- Define the palette as custom properties on \`:root\` and style components through
  the tokens. With a live Brandprint profile, the tokens ARE the profile's — apply
  its stated usage ratio rather than sprinkling the accent everywhere.
- Style both color schemes via \`@media (prefers-color-scheme: dark)\` redefining the
  tokens — viewers arrive in either. A page may commit to a single visual world (a
  terminal, a printed ticket) as a choice, never as an omission.
- Choose neutrals; don't inherit them. A grey with a slight hue bias toward the
  page's accent reads as designed; pure \`#808080\` reads as unfinished.
- Semantic color (good / warning / critical) is its own small set, separate from the
  accent. Spend boldness in exactly one place.

## Structure is information

- Lay out sibling groups with flex/grid and \`gap\`, not per-element margins that
  collapse unpredictably. Wide content (tables, code, diagrams) scrolls inside its
  own \`overflow-x: auto\` container; the page body never scrolls sideways.
- Structural devices must encode something true: number sections only when order
  carries meaning; use eyebrows and dividers to mark real boundaries, not rhythm.
- Build with the real content. Never lorem, never placeholder rows — a reviewer
  can only judge a page holding the actual material.

## The tells of a generated page (avoid unless asked)

Warm cream + serif display + terracotta accent; near-black with a single neon
accent; a purple-to-blue gradient hero on white; emoji as section markers;
everything centered; identical rounded cards with colored left rails; hairline
newspaper rules over dense columns. When the user asks for one of these, their words
win. When nothing was specified, spend the freedom elsewhere.

## Rules of this platform

- Declare \`<meta name="viewport" content="width=device-width, initial-scale=1">\`.
  Pages without one get a mobile-reflow injection whose media caps can fight
  intentional layouts (\`data-reflow-exempt\` opts an element out; the viewport meta
  opts the page out).
- Keep meaningful text as real DOM text, not pixels: review comments anchor on text
  quotes, so words baked into images can't take feedback — and feedback is what
  this platform is for.
- Binaries (images and fonts) go to \`POST /v1/assets\`; reference the returned
  URLs. Self-contained pages with self-hosted assets are the dependable path.
- Read the publish response: it echoes \`content_sha256\` (verify it when the
  content passed through your context) and may carry \`advisories\` — fix what they
  flag before reporting done.

## Before you call it done

Viewport declared · both schemes styled · no sideways body scroll · real content
throughout · binaries as assets · the response's advisories are clean. If you can
render what you shipped, look at it once — composition bugs are invisible in source.
`
