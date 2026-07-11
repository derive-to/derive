/**
 * The Brandprint build reference — the two static MCP resources behind profile
 * generation (spec: docs/plans/brandprint.md, "Reference resources"). Derive never
 * runs inference; ALL generation intelligence lives here, versioned like code, and the
 * user's own agent does the assembling. A pure leaf: no imports, safe in every build
 * (worker + node).
 *
 * - BRANDPRINT_REFERENCE (`derive://brandprint/reference`): what to build and how —
 *   required sections, extraction guidance, and the output contract.
 * - BRANDPRINT_TEMPLATE (`derive://brandprint/template`): a complete brand-neutral
 *   profile page — the structural and quality benchmark the agent restyles entirely.
 */

export const BRANDPRINT_REFERENCE = `# How to build this workspace's brand profile

You are assembling a **brand profile**: one self-contained HTML page that captures this
team's brand so well that any human can read it as the brand's home page and any agent
can apply it mechanically. It is generated once, reviewed by a human, and then served to
every agent that works in this workspace — so precision beats flourish, and honesty
beats invention.

## Inputs

1. Read \`derive://brandprint/template\` — a complete, brand-neutral profile page. It is
   your benchmark for structure, completeness, and finish. Do NOT keep its look: restyle
   everything with the brand you extract. Keep its section skeleton and its
   machine-readable conventions.
2. Read every other \`derive://brandprint/*\` source doc. "Look" docs (style guides,
   palettes, CSS, example HTML) feed Color, Typography, and Space & Shape. "Read" docs
   (voice notes, wording rules) feed Voice & Tone and Guardrails.

## Required sections, in order

1. **Essence** — a one-line positioning statement plus a short narrative paragraph:
   who this brand is, in its own voice.
2. **Personality** — the brand's archetype in one sentence, then 3-5 named traits, each
   with one sentence of what it means in practice.
3. **Color** — every color with a name, hex value, and role. State a usage ratio (for
   example 60/30/10 neutrals/primary/accent). Give light and dark values when the
   sources support them.
4. **Typography** — families, weights, and a type scale with sizes. Name the pairing
   rule (what's display, what's body, what's code).
5. **Space & Shape** — border radius scale, spacing rhythm, elevation/shadow rules.
6. **Voice & Tone** — the writing principles, then at least four on-brand / off-brand
   example pairs covering different contexts (a headline, an empty state, an error, a
   call to action).
7. **Guardrails** — at least five concrete "never" rules (things this brand does not do).
8. **Use with AI** — a short closing section telling future agents how to apply this
   profile, including that the tokens island below is the machine-readable source.

## Extraction rules

- Ground every value in the sources. Quote or derive; do not invent.
- When the sources give no evidence for a section, write the most conservative sensible
  default and mark it visibly with the word \`assumption\` so the human reviewer can
  correct it. Never leave a section out.
- If sources conflict, prefer the most recent or most specific, and note the conflict in
  one sentence.

## Output contract (hard requirements)

- **One self-contained HTML file.** No external requests of any kind: no CDN scripts, no
  webfonts, no remote images. Use system font stacks that approximate the brand's faces,
  and name the real faces in the Typography section.
- **Responsive** from 360px to 1400px; no horizontal scrolling of the page body.
- **Light and dark** both styled, via \`prefers-color-scheme\`.
- **Tokens twice over**: every design token as a CSS custom property on \`:root\`, AND a
  \`<script type="application/json" id="brandprint-tokens">\` island with the shape
  \`{ "color": {...}, "font": {...}, "space": {...}, "radius": {...} }\` using
  kebab-case token names. The island is what coding agents parse — keep it in lockstep
  with the CSS.
- **No JavaScript** beyond the JSON island. The page is a document, not an app.

## Publishing

Publish the finished page with the MCP \`publish\` tool, passing \`for_review: true\`
and the artifact short_id you were given (the workspace's "Brand profile" artifact).
It must land as a PROPOSAL — a human reviews and approves it before agents are steered
by it. Do not create a new artifact and do not publish it live.
`

export const BRANDPRINT_TEMPLATE = `<!doctype html>
<!--
  BRAND-NEUTRAL TEMPLATE — the benchmark, not the look.
  Restyle EVERYTHING with the brand you extracted: palette, type, radius, spacing,
  voice. What you must keep: the section skeleton, the completeness, the finish, the
  :root custom properties, and the #brandprint-tokens JSON island (in lockstep).
-->
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Acme — Brand profile</title>
<style>
  :root {
    --color-paper: #faf9f7;
    --color-panel: #ffffff;
    --color-ink: #1c1b1a;
    --color-soft: #5f5b56;
    --color-line: #e5e1db;
    --color-primary: #2743e0;
    --color-accent: #f2b41a;
    --color-success: #1e7f4f;
    --color-danger: #c03d2e;
    --font-display: ui-serif, Georgia, "Times New Roman", serif;
    --font-body: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    --font-mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    --space-1: 4px; --space-2: 8px; --space-3: 16px; --space-4: 24px;
    --space-5: 40px; --space-6: 64px;
    --radius-sm: 6px; --radius-md: 10px; --radius-lg: 16px;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --color-paper: #171614; --color-panel: #201f1c; --color-ink: #f0eee9;
      --color-soft: #a8a29a; --color-line: #35332f; --color-primary: #7d90f5;
      --color-accent: #f2b41a;
    }
  }
  * { box-sizing: border-box; margin: 0; }
  body {
    background: var(--color-paper); color: var(--color-ink);
    font: 16px/1.6 var(--font-body);
  }
  header.hero {
    padding: var(--space-6) var(--space-4); text-align: center;
    border-bottom: 1px solid var(--color-line);
  }
  .hero .kicker {
    display: inline-block; font-size: 13px; letter-spacing: .08em;
    text-transform: uppercase; color: var(--color-soft);
    border: 1px solid var(--color-line); border-radius: 999px;
    padding: var(--space-1) var(--space-3); margin-bottom: var(--space-3);
  }
  .hero h1 { font: 500 clamp(32px, 6vw, 56px)/1.15 var(--font-display); }
  .hero p.essence {
    max-width: 640px; margin: var(--space-3) auto 0; font-size: 19px;
    color: var(--color-soft);
  }
  nav.toc {
    position: sticky; top: 0; background: var(--color-paper);
    border-bottom: 1px solid var(--color-line); overflow-x: auto;
    display: flex; gap: var(--space-3); padding: var(--space-2) var(--space-4);
    font-size: 14px; z-index: 2;
  }
  nav.toc a { color: var(--color-soft); text-decoration: none; white-space: nowrap; }
  nav.toc a:hover { color: var(--color-ink); }
  main { max-width: 960px; margin: 0 auto; padding: var(--space-5) var(--space-4) var(--space-6); }
  section { margin-bottom: var(--space-6); }
  section > h2 {
    font: 500 28px/1.2 var(--font-display); margin-bottom: var(--space-2);
  }
  section > p.lead { color: var(--color-soft); max-width: 640px; margin-bottom: var(--space-4); }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: var(--space-3); }
  .card {
    background: var(--color-panel); border: 1px solid var(--color-line);
    border-radius: var(--radius-md); padding: var(--space-3) var(--space-4);
  }
  .card h3 { font-size: 15px; margin-bottom: var(--space-1); }
  .card p { font-size: 14px; color: var(--color-soft); }
  .swatches { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: var(--space-3); }
  .swatch { border: 1px solid var(--color-line); border-radius: var(--radius-md); overflow: hidden; background: var(--color-panel); }
  .swatch .chip { height: 72px; }
  .swatch dl { padding: var(--space-2) var(--space-3); font-size: 13px; }
  .swatch dt { font-weight: 600; }
  .swatch dd { color: var(--color-soft); font-family: var(--font-mono); font-size: 12px; }
  .ratio { display: flex; border-radius: var(--radius-md); overflow: hidden; height: 40px; margin-top: var(--space-3); border: 1px solid var(--color-line); }
  .type-specimen { border-left: 3px solid var(--color-accent); padding-left: var(--space-3); margin-bottom: var(--space-3); }
  .type-specimen .label { font-size: 12px; color: var(--color-soft); font-family: var(--font-mono); }
  .shape-row { display: flex; gap: var(--space-3); flex-wrap: wrap; align-items: flex-end; }
  .shape { background: var(--color-panel); border: 1px solid var(--color-line); width: 96px; height: 64px; display: grid; place-items: end center; font-size: 12px; color: var(--color-soft); padding-bottom: var(--space-1); }
  .voice-pair { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); margin-bottom: var(--space-3); }
  @media (max-width: 560px) { .voice-pair { grid-template-columns: 1fr; } }
  .voice { border-radius: var(--radius-md); padding: var(--space-3); font-size: 14px; border: 1px solid var(--color-line); background: var(--color-panel); }
  .voice .tag { display: inline-block; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; border-radius: 999px; padding: 1px 8px; margin-bottom: var(--space-2); }
  .voice.on .tag { background: color-mix(in srgb, var(--color-success) 15%, transparent); color: var(--color-success); }
  .voice.off .tag { background: color-mix(in srgb, var(--color-danger) 12%, transparent); color: var(--color-danger); }
  .voice .ctx { font-size: 12px; color: var(--color-soft); margin-top: var(--space-2); }
  ul.guardrails { padding-left: 0; list-style: none; }
  ul.guardrails li { padding: var(--space-2) 0 var(--space-2) var(--space-4); border-bottom: 1px solid var(--color-line); position: relative; }
  ul.guardrails li::before { content: "✕"; position: absolute; left: 0; color: var(--color-danger); font-weight: 700; }
  footer.ai { border-top: 1px solid var(--color-line); padding: var(--space-4); text-align: center; font-size: 14px; color: var(--color-soft); }
  footer.ai code { font-family: var(--font-mono); font-size: 13px; }
  .assumption { background: color-mix(in srgb, var(--color-accent) 18%, transparent); border-radius: var(--radius-sm); padding: 0 var(--space-1); font-size: 13px; }
</style>
</head>
<body>

<header class="hero">
  <span class="kicker">Brand profile</span>
  <h1>Clarity you can act on.</h1>
  <p class="essence">Acme turns messy operational data into decisions a team can make
  before lunch — plain-spoken, precise, and allergic to dashboards for their own sake.</p>
</header>

<nav class="toc" aria-label="Sections">
  <a href="#essence">Essence</a>
  <a href="#personality">Personality</a>
  <a href="#color">Color</a>
  <a href="#typography">Typography</a>
  <a href="#space">Space &amp; shape</a>
  <a href="#voice">Voice &amp; tone</a>
  <a href="#guardrails">Guardrails</a>
  <a href="#ai">Use with AI</a>
</nav>

<main>

<section id="essence">
  <h2>Essence</h2>
  <p class="lead"><strong>Positioning:</strong> the analytics tool for operators who read
  numbers like a native language but have no patience for ornament.</p>
  <p>Acme's brand behaves like its best customer: direct, warm enough to trust, and
  ruthless about what earns space on a page. Every surface should feel like a well-run
  meeting — an agenda, the facts, a decision.</p>
</section>

<section id="personality">
  <h2>Personality</h2>
  <p class="lead">The archetype: a senior operator who explains without condescending.</p>
  <div class="cards">
    <div class="card"><h3>Direct</h3><p>Leads with the point. One idea per sentence, one
    message per screen.</p></div>
    <div class="card"><h3>Grounded</h3><p>Claims carry evidence. Numbers over adjectives,
    examples over abstractions.</p></div>
    <div class="card"><h3>Warm</h3><p>Talks like a person. Contractions welcome, jargon
    translated on arrival.</p></div>
    <div class="card"><h3>Unhurried</h3><p>Never shouts. Energy comes from rhythm and
    word choice, not punctuation.</p></div>
  </div>
</section>

<section id="color">
  <h2>Color</h2>
  <p class="lead">A 60/30/10 system: warm paper neutrals carry the weight, primary blue
  marks action, amber punctuates. <span class="assumption">assumption</span>: dark values
  derived, no dark-mode source provided.</p>
  <div class="swatches">
    <div class="swatch"><div class="chip" style="background:#faf9f7"></div><dl><dt>Paper</dt><dd>#FAF9F7 · surfaces, 60%</dd></dl></div>
    <div class="swatch"><div class="chip" style="background:#1c1b1a"></div><dl><dt>Ink</dt><dd>#1C1B1A · text</dd></dl></div>
    <div class="swatch"><div class="chip" style="background:#2743e0"></div><dl><dt>Primary</dt><dd>#2743E0 · actions, 30%</dd></dl></div>
    <div class="swatch"><div class="chip" style="background:#f2b41a"></div><dl><dt>Accent</dt><dd>#F2B41A · highlights, 10%</dd></dl></div>
    <div class="swatch"><div class="chip" style="background:#1e7f4f"></div><dl><dt>Success</dt><dd>#1E7F4F · confirmation</dd></dl></div>
    <div class="swatch"><div class="chip" style="background:#c03d2e"></div><dl><dt>Danger</dt><dd>#C03D2E · destructive, errors</dd></dl></div>
  </div>
  <div class="ratio" role="img" aria-label="Usage ratio 60/30/10">
    <div style="flex:6;background:#faf9f7"></div>
    <div style="flex:3;background:#2743e0"></div>
    <div style="flex:1;background:#f2b41a"></div>
  </div>
</section>

<section id="typography">
  <h2>Typography</h2>
  <p class="lead">Two families: a serif for display (this page approximates it with the
  system serif — the real face is <strong>Tiempos Headline, medium only</strong>) and a
  humanist sans for everything else (<strong>General Sans</strong>, regular to semibold).</p>
  <div class="type-specimen"><span class="label">display / 40px / 1.15</span>
    <p style="font:500 40px/1.15 var(--font-display)">Decisions before lunch</p></div>
  <div class="type-specimen"><span class="label">heading / 24px / 1.25</span>
    <p style="font:600 24px/1.25 var(--font-body)">Weekly throughput, explained</p></div>
  <div class="type-specimen"><span class="label">body / 16px / 1.6</span>
    <p>Body copy stays at 16px with a roomy line height. Emphasis is semibold, never
    italic-plus-bold, never underline.</p></div>
  <div class="type-specimen"><span class="label">mono / 13px</span>
    <p style="font:13px var(--font-mono)">acme.report(week).then(decide)</p></div>
</section>

<section id="space">
  <h2>Space &amp; shape</h2>
  <p class="lead">A 4px base rhythm (4/8/16/24/40/64). Corners are soft but not playful;
  elevation is a hairline border first, shadow only when something floats.</p>
  <div class="shape-row">
    <div class="shape" style="border-radius:var(--radius-sm)">sm 6</div>
    <div class="shape" style="border-radius:var(--radius-md)">md 10</div>
    <div class="shape" style="border-radius:var(--radius-lg)">lg 16</div>
    <div class="shape" style="border-radius:999px">pill</div>
  </div>
</section>

<section id="voice">
  <h2>Voice &amp; tone</h2>
  <p class="lead">Sentence case everywhere. Product names are proper nouns. No
  exclamation marks — energy comes from word choice and rhythm.</p>
  <div class="voice-pair">
    <div class="voice on"><span class="tag">On brand</span>Your week, sorted. Three
    things need a decision.<p class="ctx">hero headline</p></div>
    <div class="voice off"><span class="tag">Off brand</span>Supercharge your workflow
    with powerful insights!<p class="ctx">hero headline</p></div>
  </div>
  <div class="voice-pair">
    <div class="voice on"><span class="tag">On brand</span>Nothing here yet. Connect a
    data source and this fills itself in.<p class="ctx">empty state</p></div>
    <div class="voice off"><span class="tag">Off brand</span>Oops! Looks like you have no
    data :(<p class="ctx">empty state</p></div>
  </div>
  <div class="voice-pair">
    <div class="voice on"><span class="tag">On brand</span>That upload didn't finish —
    the file is over 50 MB. Split it and try again.<p class="ctx">error</p></div>
    <div class="voice off"><span class="tag">Off brand</span>Error 413: payload too
    large.<p class="ctx">error</p></div>
  </div>
  <div class="voice-pair">
    <div class="voice on"><span class="tag">On brand</span>Start the import<p class="ctx">call to action</p></div>
    <div class="voice off"><span class="tag">Off brand</span>Unleash the power of data!<p class="ctx">call to action</p></div>
  </div>
</section>

<section id="guardrails">
  <h2>Guardrails</h2>
  <p class="lead">What this brand never does.</p>
  <ul class="guardrails">
    <li>Never use exclamation marks in product copy.</li>
    <li>Never use gradients on UI surfaces; flat color only.</li>
    <li>Never open with a feature name — open with the customer's outcome.</li>
    <li>Never use more than one accent-colored element per view.</li>
    <li>Never write Title Case headings; sentence case throughout.</li>
    <li>Never stack more than two font weights on one screen.</li>
  </ul>
</section>

</main>

<footer class="ai" id="ai">
  <p><strong>For agents:</strong> this page is the source of truth for Acme's brand.
  Apply the tokens below (also mirrored as CSS custom properties on <code>:root</code>)
  and follow Voice &amp; tone and Guardrails for every word you write. When this profile
  and any other source disagree, this profile wins.</p>
</footer>

<script type="application/json" id="brandprint-tokens">
{
  "color": {
    "paper": "#FAF9F7", "panel": "#FFFFFF", "ink": "#1C1B1A", "soft": "#5F5B56",
    "line": "#E5E1DB", "primary": "#2743E0", "accent": "#F2B41A",
    "success": "#1E7F4F", "danger": "#C03D2E",
    "dark-paper": "#171614", "dark-panel": "#201F1C", "dark-ink": "#F0EEE9",
    "dark-soft": "#A8A29A", "dark-line": "#35332F", "dark-primary": "#7D90F5"
  },
  "font": {
    "display": "Tiempos Headline, ui-serif, Georgia, serif",
    "body": "General Sans, ui-sans-serif, system-ui, sans-serif",
    "mono": "ui-monospace, SF Mono, Menlo, monospace",
    "scale": { "display": "40px", "heading": "24px", "body": "16px", "mono": "13px" }
  },
  "space": { "1": "4px", "2": "8px", "3": "16px", "4": "24px", "5": "40px", "6": "64px" },
  "radius": { "sm": "6px", "md": "10px", "lg": "16px", "pill": "999px" }
}
</script>

</body>
</html>
`
