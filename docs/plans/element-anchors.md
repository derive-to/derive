# Dock: layered anchoring (beyond a single text quote)

Two gaps in Dock's anchor model, fixed together:

1. A comment can only attach to a **text quote** today. Our own
   [STANDARD.md](../../STANDARD.md) admits it: "baked-in screenshots can't be
   commented on." Charts, images, diagrams, and slide regions cannot carry
   feedback, even though they are the parts of a rich artifact people most want to
   react to.
2. An anchor is a **single locator**. When the underlying content moves or is
   rewritten, a lone selector either resolves or it does not, and when it does not,
   the comment is simply lost.

This plan does both: it adds a non-text anchor kind, and it makes every anchor a
**cascade of independent locators** plus a preserved snapshot, so a comment degrades
gracefully instead of disappearing. Companion to
[collaboration-layer.md](./collaboration-layer.md).

## What we keep

- The anchor-client protocol runs inside the sandboxed iframe and speaks
  `postMessage` (`select`, `anchors-resolved`, `anchor-click`).
- Text comments anchor to a W3C `TextQuoteSelector` and re-resolve on republish by
  exact-with-context, then exact-anywhere. That stays as **Layer 2 for text**.
- Highlights and overlays live in the served client, never in the artifact bytes.

We are adding a second anchor kind alongside the text quote, and we are adding more
**layers** under both kinds. A comment's anchor becomes a tagged union:

```
type Anchor =
  | { kind: "text";    text: TextQuoteSelector; layers: AnchorLayers }
  | { kind: "element"; layers: AnchorLayers }
```

## The layered anchor

Every anchor captures several independent locators at comment time, strongest to
weakest. None of them is load-bearing on its own.

```
AnchorLayers = {
  // L0 - explicit durable handle (author opt-in). Survives almost anything.
  anchorId?: string          // value of data-dock-anchor

  // L1 - precise path. Best when the DOM is stable.
  css?: string               // depth-capped, e.g. "main > figure:nth-of-type(2)"

  // L2 - content identity. Finds "the same thing" wherever it moved.
  fingerprint: {
    tag: string              // "img" | "svg" | "figure" | "canvas" | "p" | ...
    src?: string             // image src basename
    hash?: string            // content hash: same-origin bytes, or normalized markup
    label?: string           // alt / aria-label / title / <figcaption> text
    textHash?: string        // hash of normalized innerText, for text-bearing blocks
  }

  // L3 - structure. "the 2nd chart under 'Revenue'".
  ordinal: {
    section?: string         // nearest preceding heading text
    kindIndex: number        // index among same-tag elements, in document order
  }

  // L4 - geometry. The "save position as stuff moves" layer.
  position: {
    docFraction: number      // element top as a fraction of total doc height (0..1)
    rect: { w: number; h: number; ar: number }  // size + aspect ratio
  }

  // L5 - neighbors. "between these two still-stable things".
  neighbors?: { prev?: SignalLite; next?: SignalLite }
}
```

`css` uses a depth-capped selector walk: up a few levels, short-circuit on a stable
`id`, disambiguate same-tag siblings with `:nth-of-type`. It is the least durable
field, which is exactly why it is only one layer of several.

## Resolution: a scored cascade

On the live client and server-side at republish, run every layer that is present,
collect the element(s) each one points to, and **score candidates by agreement**:

1. Each layer that resolves contributes its candidate(s), weighted (L0 highest, L4
   lowest).
2. An element that several layers independently point to wins. Agreement is the
   signal, not any single locator.
3. The top candidate's combined score sets a **confidence**:
   - **High** (a strong layer plus agreement): carry the comment silently.
   - **Medium** (only weak layers, or layers disagree): carry it, but mark
     "re-anchored, confirm?" so a human or the agent verifies rather than trusting.
   - **None above threshold**: the target is gone. Do not silently move it.

This is the same philosophy text anchoring already uses (context first, then looser
match, then give up honestly), generalized to many locators and made explicit about
confidence.

## When the target is gone

A lost comment should never just vanish. Two recoveries, in order:

### 1. Preserve the target (snapshot)

At comment time we also store, **in the overlay, never in the artifact bytes**, a
small record of what was anchored:

```
Snapshot = {
  outline: string        // short outerHTML excerpt, or the quoted text
  thumb?: string         // tiny data-URL render for an image/chart (optional)
  context: string        // preceding heading + neighbor text
  madeOnVersion: number  // the artifact version this anchor was created against
}
```

An orphaned comment then **shows what it pointed at** ("was on the Q3 Revenue chart,
under 'Performance', about 40% down the page"), with the thumbnail if we have one,
instead of a bare "element changed." The agent reading comments over MCP receives
the same snapshot, so it can relocate the intent itself.

### 2. Recover via version history (Dock's advantage)

Dock keeps every version server-side, which the in-iframe-only tools do not. So an
orphaned anchor has one more move: re-resolve it against the **exact version it was
made on** (`madeOnVersion`), where every layer still matches perfectly, identify the
original element there, then walk the diff **forward** to its most likely successor
in the current version. A comment made three versions ago can be carried forward
hop by hop instead of dropped because the latest DOM drifted too far at once.

## Authoring guidance (mirrors the text-quote rules)

One optional addition to STANDARD.md section 1, alongside "keep headings and
distinctive phrases stable":

- **Put `data-dock-anchor="…"` on charts, figures, and slide regions you expect
  feedback on.** It becomes Layer 0, the strongest handle, and makes an element
  anchor as durable as a stable heading. Never required: without it the lower layers
  still apply.

## Protocol additions

Additive to STANDARD.md section 2. Old clients and old artifacts keep working; they
simply never send or receive the new fields.

### Artifact frame to host (`source: "dock"`)

- `select` may carry an element anchor (`kind: "element"`) with the captured layers
  when the user picks an element instead of text. The user enters **element-pick
  mode**: hovering paints a soft outline around the smallest anchorable element
  under the cursor; clicking posts the anchor. Selecting text, or pressing the key
  again, exits the mode.

### Host to artifact frame (`source: "dock-host"`)

- `anchors` gains element entries plus a per-anchor `confidence`. The client paints
  an element anchor as an **outline overlay** (absolutely positioned, so we never
  mutate the artifact DOM) instead of a `<mark>` wrap, and renders medium-confidence
  anchors with a "confirm?" affordance. `anchor-click` is posted on click as today.
- `focus-anchor` scrolls to and flashes an element anchor like a text one.

## UX flow

- **Entering.** One affordance, not a toolbar: a "comment on element" toggle in the
  existing selection toolbar plus a keyboard shortcut. Until you start, the artifact
  looks untouched.
- **Picking.** Hover paints a soft outline on the smallest anchorable element
  (img, svg, figure, canvas, or an explicit `data-dock-anchor` box). Modifier-hover
  walks up to the parent if you meant the whole figure, not the image inside it.
- **Commenting.** Click drops a margin pin and opens the **same composer** used for
  text anchors.
- **Reviewing.** Element and text comments share one pin rail. Re-anchored
  (medium-confidence) pins show a small "confirm" dot; orphaned pins collapse to a
  "could not place" group at the top that still renders each snapshot, so nothing is
  silently lost.

## Phasing

1. **Capture.** `AnchorLayers` capture in the served client for both kinds (no UI
   yet); store and round-trip through `add_comment` and republish.
2. **Cascade.** The scored resolver and confidence, on client and server. Snapshot
   storage in the overlay.
3. **Gone case.** Orphan group UI with snapshots; version-history forward-walk
   recovery.
4. **Element UI.** Pick-mode, outline overlay, unified pin rail, confirm affordance.
5. **Docs.** STANDARD.md note for `data-dock-anchor`.

## Open questions

- Layer weights and the high/medium thresholds want real artifacts to tune. Start
  conservative (favor "confirm?" over silent moves) and adjust.
- `fingerprint.hash` for same-origin image bytes is easy; cross-origin or
  canvas-rendered charts may only give us `rect` + `label`. Acceptable: those just
  lean on lower layers.
- Version-history forward-walk cost: walking many hops server-side on every stale
  anchor could be heavy. Cache the resolved mapping per (anchor, version) so it is
  computed once.
- Geometry layer for reflowable artifacts (Markdown at different widths): store
  `docFraction` rather than pixels so it stays meaningful across viewport sizes,
  which the schema already does.
