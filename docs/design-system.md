# Derive Design System

The monochrome "ink on paper" identity, built on Derive's stack: Vite + React 19 +
TanStack Router + Tailwind v4 + shadcn/Radix. The brand reads as its two canvas colors —
**Axiom Black `#030712`** and **Origin White `#F4F5F8`** — no chromatic brand accent. They aren't
pure gray, though: the whole scale carries a deliberate, faint cool cast (one hue ~264°,
near-zinc chroma — Axiom Black is Tailwind `gray-950`), kept low enough to read as a
temperature, not a color. That's what "monochrome" means here — one hue, not zero. Light (paper) and
dark (ink) are both first-class: light is the `:root` base, dark is the `.dark` override,
and the accent in each is simply ink — near-black on the paper canvas, near-white on the
dark one. This file is the source of truth for every component in
`apps/web/src/components` and every page in `apps/web/src/pages`.

## Personality

Editorial, calm, precise. Closer to a well-set magazine or Linear than to a busy SaaS
dashboard. One family — **Geist** — carries everything: Geist Sans for the working UI and
the moments of voice (greetings, artifact titles, empty-state headlines) alike; Geist Mono
handles the machine-facing layer (counts, versions, timestamps, kbd, code). Ink, never
pure black; paper, never pure white. The accent is **monochrome ink** — near-black on
paper, near-white on the dark canvas — so nothing is "the brand color"; the identity is
the two canvases themselves. Color is rationed: past the neutrals' own faint cool cast, only the semantic signals
(success / warning / destructive) and a small family of calm, low-chroma wayfinding
tints carry any *saturated* hue — calm tints, not a rainbow.

## Color

All color flows through the semantic tokens in `apps/web/src/styles/globals.css`.
Components never use raw palette classes (`bg-zinc-*`, `text-red-*`) — the token linter
(`scripts/check-design-tokens.mjs`) enforces this outside `components/ui/**`, and `ui/`
holds itself to the same standard voluntarily.

### The palette (defined once in globals.css)

- **Monochrome neutrals** — the whole chrome rides one near-neutral scale. "Monochrome"
  is literal but means *one hue, not none*: every neutral sits at a single cool hue
  (~264°, the gray/slate family) held at near-zinc chroma (~0.005–0.013), so it reads as a
  temperature, not a color — the white `#ffffff` card is the lone true-neutral token.
  Light: canvas
  `#f7f8fa` (paper), card/popover white `#ffffff`, ink `#14161a` (the "black" — never
  `#000`), secondary text `#5c616b` (≥4.5:1 on the canvas), decoration-only `#aeb2ba`.
  Dark: canvas `#0a0b0d`, raised card/popover `#101216`, ink `#f3f4f6` (the "white" —
  never `#fff`), secondary text `#969aa2`. The foundation colors are **Axiom Black
  `#030712`** (Tailwind `gray-950`) and **Origin White `#F4F5F8`** — the fixed on-image
  scrim pair, and the origin the two canvases resolve toward. The scrim is the most
  chromatic neutral in the system (`gray-950`, chroma ~0.028), on purpose: it dims
  rendered content with a cinematic cool-black, not a flat gray.
- **Accent — monochrome ink.** `--primary` *is* the ink: `#14161a` on light, `#f3f4f6`
  on dark. There is no brand hue and no brand ramp — soft "brand" chips are just the ink
  at low opacity (`bg-primary/10 text-primary`). Primary actions, active nav, focus,
  links, and selected states all render in ink or a quiet neutral wash.
- **Semantic signals** — **success** green (`#2f7d4f` light / `#74b085` dark),
  **warning** safety-orange (`#a24200` / `#fb923c`), **destructive** red (`#b4402c` /
  `#d98c74`). One per-theme token each (`--success`, `--warning`, `--destructive`);
  derive fills and edges with opacity modifiers (`bg-success/10`, `ring-warning/25`).
  Warning is a saturated signal held clearly apart from the muted wayfinding tints, so
  an alert never reads as decoration — and status is never the accent.
- **Calm categorical tints** — a muted, low-chroma family for feature wayfinding and
  categorical charts: `--color-share`, `--color-review`, `--color-insights`,
  `--color-collection`, `--color-comments`, `--color-tag`, `--color-gold` (with
  `--chart-1…5` mirroring them). Theme-invariant by design, surfaced as `text-share` /
  `text-review` / … utilities and applied per call-site — never a blanket icon default,
  so a glyph inside a button or an active nav row still takes that surface's ink. "Calm
  tints, not a rainbow."

### Semantic assignments — light

Light is the `:root` base and a full first-class theme (not a lesser derivation of dark).
The paper canvas `#f7f8fa` carries white cards that lift off it by a fill step + hairline
+ soft shadow.

| Token | Value | Role |
|---|---|---|
| `background` | `#f7f8fa` | the floating content card (inset shell); the rail is a recessed `--sidebar` `#e9ebf1` backdrop a step below it |
| `card` / `popover` | `#ffffff` | raised (dialogs, palette, lifting cards) + floating (menus, tooltips, toasts) surfaces — white lifts off the paper |
| `primary` / `primary-foreground` | `#14161a` / `#f7f8fa` | monochrome ink; a primary fill carries the canvas color as its text, never a third color |
| `secondary` / `muted` | `#eff1f4` | quiet fills: secondary buttons, input wells, skeletons, kbd |
| `muted-foreground` | `#5c616b` | secondary text (≥4.5:1 on the canvas) |
| `accent` | `#e8eaee` | selected/hover wash — near-neutral (the same faint cool cast, not a saturated hue) |
| `border` / `input` | `#e5e7eb` | the standard hairline; `border-soft` `#eef0f3` is the quietest divider |
| `ring` | `#14161a` | focus is ink, never blue |
| `destructive` / `success` / `warning` | `#b4402c` / `#2f7d4f` / `#a24200` | the only chromatic tokens besides the wayfinding tints |
| shadows | soft, kept | light KEEPS soft shadows — the no-shadow rule is dark-only |

### Semantic assignments — dark

The `.dark` override. Surfaces separate by a fill step plus a hairline edge instead of a
shadow; the accent is now the paper color, doing duty as ink on the dark canvas.

| Token | Value | Role |
|---|---|---|
| `background` | `#0a0b0d` | app canvas; the shell sits FLUSH on it |
| `card` / `popover` | `#101216` | raised (dialogs, palette) + floating (menus, tooltips, toasts) surfaces |
| `primary` / `primary-foreground` | `#f3f4f6` / `#0a0b0d` | monochrome ink — near-white on the dark canvas |
| `secondary` / `muted` | `#16181d` | quiet fills |
| `muted-foreground` | `#969aa2` | secondary text |
| `accent` | `#1b1d23` | selected/hover wash |
| `border` / `input` | `#23252b` | the standard hairline (solid, low-contrast); `border-soft` `#191b1f` is the quietest divider |
| `ring` | `#f3f4f6` | focus is ink |
| `destructive` / `success` / `warning` | `#d98c74` / `#74b085` / `#fb923c` | soft-fill semantic signals |
| shadows | `0 0 #0000` | **no shadows in dark** — elevation is a surface step plus a `ring-1 ring-foreground/10` edge |

### Ink deployment rules (the discipline that makes it work)

The accent is ink, so restraint is the whole game — ink is where the eye must land, and
it means nothing if it's everywhere. Ink is reserved for: **primary actions, the
active-nav label, focus rings, links, the selected-tab underline, unread dots, and
machine/brand moments** (spinner head, sync chip). Everything else stays neutral:

- Selected filters, segments, toggle-groups, list rows, active/hovered cards, and
  reacted (toggled-on) reaction chips: **neutral washes** (`bg-accent`, `bg-foreground/5`)
  with re-inked text — never a tint or an edge tick. There is no colored active tick
  anywhere, including the review rail.
- Menu keyboard focus and hover: `bg-accent`, neutral.
- **One filled primary button per page/dialog.** Everything else is secondary/ghost.
  Because the fill is ink and not a loud hue, a second filled button genuinely competes —
  so there's only ever one.
- On a primary (ink) fill, text and glyphs are `text-primary-foreground` — the canvas
  color, handled by the token; never hand-pick white.
- Warnings are `warning` orange, never the accent. Status is `success` / `warning` /
  `destructive`; ink is not a status.
- The wayfinding tints (`text-share`, `text-review`, …) color feature glyphs and chart
  series only — never chrome, never a CTA.

## Typography

One family. **Geist Variable** (`font-sans`) carries the entire app — the working chrome
*and* the moments of voice — and **Geist Mono Variable** (`font-mono`) carries the machine
layer. Both cuts are weight-only (no optical-size axis) and self-hosted via fontsource, so
the app makes no third-party font requests; there is no serif webfont.

| Register | Family | Used for |
|---|---|---|
| chrome & voice | `Geist Variable` (`font-sans`) | all working UI — controls, labels, headings, dialog/card titles — and the voice moments: the wordmark, login/welcome headlines, empty-state headlines, artifact (content) titles |
| machine | `Geist Mono Variable` (`font-mono`, over a `ui-monospace, Menlo, Consolas` fallback) | counts, versions, timestamps, kbd, code, uppercase micro-eyebrows |

`font-serif` still exists as a utility, but it is **aliased to Geist** (`--font-serif:
var(--font-sans)`) — a per-call-site marker for voice moments, not a second face.

Rules:

- Keep Derive's type scale (control base `text-sm` 14px, body `text-base` 16px,
  `text-2xs` 11px for mono micro-labels only). Never `text-xs` for body copy. The scale
  caps tight — the hero step is `text-4xl` 32px — to hold the calm monochrome register.
- Headings: `font-medium` or `font-semibold`, never `font-bold`; `tracking-tight` above
  `text-xl` (globals.css already tightens h1–h6 letter-spacing); no `leading-*` overrides
  on headings; `text-balance` on headings, `text-pretty` on paragraphs.
- `uppercase` only on mono eyebrows, always with `tracking-wide` (the `SectionEyebrow`
  grammar).
- Numbers that change (counts, stats, timers): `tabular-nums`.
- Voice moments are set per call-site (`font-serif font-medium tracking-tight` —
  `font-serif` being the Geist alias), NOT via a `--font-heading` override; every heading
  is Geist.

## Surfaces, edges, elevation

- **Inset shell**: the nav rail is the app's only persistent desktop chrome — there is no
  global top bar. The shell runs the shadcn `inset` variant: the rail is a **recessed
  backdrop** (`bg-sidebar`, a step off the canvas — a hair below paper in light, a hair
  above the near-black in dark) and every routed page floats above it as a rounded content
  card (`SidebarInset` → `rounded-xl` + a soft shadow in light, a `ring-sidebar-border`
  hairline carrying the edge in dark). One recessed plane, one floating plane. The inset is
  desktop-only — below `md` the content goes full-bleed under the sticky `MobileTopBar`.
- Cards only when content is independently interactive or must lift; prefer whitespace →
  hairline dividers → wells (`bg-secondary`) → cards, in that order.
- Light separates surfaces with a fill step: the paper canvas `#f7f8fa` carries white
  `#ffffff` cards that lift by hairline + soft shadow. Dark has no shadow — a card
  separates by its surface step (`bg-card`) plus a hairline / `ring-1 ring-foreground/10`
  edge.
- Floating elements (menus, popovers, dialogs, toasts): surface step + `ring-1
  ring-foreground/10`; shadows come from the theme shadow tokens (visible in light, zeroed
  in dark).
- Never a heavy mid-gray divider; edges are the low-contrast hairline tokens
  (`border-border`, `border-border-soft`).
- Images/screenshots/thumbnails: no borders — `outline-1 -outline-offset-1
  outline-foreground/10`.

## Radius

`--radius: 0.25rem` (4px) — tight corners are part of the register. Workhorse
`rounded-lg` (8px) for buttons/inputs/menu items; `rounded-md` (6px) for dense controls
(xs buttons, badges); `rounded-xl` (10px) for menus and cards; `rounded-2xl` (12px) for
dialogs. The steps are deliberately compressed (3–12px) and are NOT a doubling scale —
`rounded-2xl` is 12px, not radius×2. Concentric nesting: inner radius = outer radius −
padding.

## Focus

- Clickables (buttons, links, menu triggers, nav rows):
  `focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring`
  — a solid **ink** outline, offset.
- Editables (input, textarea, select trigger): `focus-visible:border-ring
  focus-visible:ring-2 focus-visible:ring-ring/40` — an **ink** border + soft glow, no
  offset (never `outline-offset` on inputs).

## Cursor

The arrow everywhere, Linear-style. Links and buttons keep the default cursor — no
`cursor-pointer` in app chrome; hover states, not the hand, signal clickability
(globals.css sets `a { cursor: default }` to override the browser's link pointer).
Functional cursors stay: text fields keep the I-beam, resize handles keep resize
cursors, drag surfaces keep grab. Authored artifact content renders in its own
iframe and keeps web-native cursors — we're a guest in the author's document.

## Motion

Fast and quiet. No hover color/background transitions — color changes are instant
(`transition-*` is reserved for elements that move, scale, or fade: dialog/popover
entrances via tw-animate-css, the sheet slide, toast rise). Entrance timing ≈ 200ms
ease-out. Active press: `active:translate-y-px` on buttons (suppressed on menu triggers,
so open panels don't jitter). Respect `prefers-reduced-motion` (already globally handled
in globals.css).

## Icons

**lucide-react only** (Phosphor is removed). `size-4` (16px) in app UI — the shared
`Icon` defaults to 16; mono-register meta rows may step down to 12 (`size-3`, pairs with
`text-2xs`); editorial/empty-state icons `size-6` with `strokeWidth={1.75}`. Those three
steps only — no 13/14/18px one-offs. Always `shrink-0` inside flex rows. Color via
`text-*` utilities (lucide inherits currentColor); feature glyphs may take a wayfinding
tint (`text-share`, `text-review`, …) at the call-site, but a tint is never a blanket icon
default — a glyph inside a button or an active row takes that surface's ink. Never wrap
icons in decorative containers. Route shared icons through `components/icons.tsx`; pages
may import lucide directly for one-offs.

## Component recipes (ui/)

APIs, exported names, `data-slot` attributes, and `data-testid`s are stable — only the
visual recipes change. React 19 style (no forwardRef), `cn()` from `lib/utils`, cva for
variants.

- **Button** — variants: `default` (ink fill, canvas-colored text via
  `text-primary-foreground`, a subtle inset top-light
  `shadow-[inset_0_1px_0_--theme(--color-white/20%)]` that reads as a lit edge; hover
  steps the fill toward the canvas direction — darker in light, lighter in dark);
  `secondary` (`bg-secondary` + `border-input`, hover brightens the edge); `ghost`
  (hover `bg-secondary`); `outline` (hairline only); `destructive` (soft:
  `bg-destructive/10 text-destructive`, hover `/15` — confirm destructive intent via
  dialog, never a loud red fill); `destructive-ghost` (row-action delete in lists and
  menus: destructive ink at rest, the soft wash on hover only); `success` / `warning`
  (the destructive soft-fill grammar in the status hues — approve / request-changes;
  status is never the accent); `link`. Two workhorse heights: `default` h-9 and `sm` h-8
  (+ icon sizes); `xs` h-7 (dense meta rows) and `lg` h-10 (auth CTAs) are the sanctioned
  edges — never hand-roll a fifth height. `loading` disables the button and leads with a
  current-ink spinner while the caller keeps the verb label ("Saving…") — not supported
  under `asChild`. Buttons are verbs.
- **Badge** — flat rounded-md chips, no borders: `default` / `secondary` (neutral
  `bg-accent text-foreground` — the two are aliases), `brand` (soft ink `bg-primary/10
  text-primary`), `success` / `warning` / `destructive` (`bg-<tone>/10 text-<tone>`),
  `outline` (hairline). Icon-leading badges use asymmetric padding (`pl-1` against the
  `pr-2` base). `shape="pill"` is the machine-register chip — rounded-full mono 2xs
  tabular for counts, versions, slide markers, statuses (pairs with size-3 icons) — the
  ONE sanctioned pill; never hand-roll a chip.
- **Kbd** — `font-mono text-2xs bg-muted` chip.
- **Input / Textarea** — a quiet input well with a hairline `border-input`, **ink** focus
  per the Focus rules; invalid = `border-destructive`. Autofill is repainted with tokens
  (WebKit's yellow fill fails both themes). Native control chrome follows the theme via
  `color-scheme` on `:root`/`.dark` in globals.css — never per-control `scheme-dark`
  patches. Textarea auto-grows via `field-sizing-content`.
- **Dialog / Sheet** — overlay `bg-scrim/50` (the fixed Axiom-Black scrim); panel `bg-card
  rounded-2xl ring-1 ring-foreground/10`; 200ms entrance. Titles are chrome (plain Geist),
  not a `font-serif` voice moment. Content caps at `100dvh-2rem` with internal scroll.
  Every DialogContent has a DialogDescription or passes `aria-describedby={undefined}`
  (the Radix opt-out — no dangling refs). Bottom sheets pad `env(safe-area-inset-bottom)`.
- **Dropdown-menu / Popover / Select / Command** — `bg-popover ring-1 ring-foreground/10
  rounded-xl`; item focus/hover `bg-accent` (neutral); destructive items `text-destructive`;
  command palette panel on `bg-card`.
- **Tooltip** — surface style, not inverted: `bg-popover text-popover-foreground ring-1
  ring-inset ring-foreground/10 rounded-md px-2 py-1 text-xs`, no arrow. Provider delay
  300ms with skip-delay 300ms (quiet mouse travel, instant across grouped icon buttons).
  Icon-only chrome gets a Tooltip, never a `title` attr (title is invisible to keyboard +
  touch) — and the tooltip is never the only label: `aria-label` stays. CAUTION: never
  stack `TooltipTrigger asChild` over `PopoverTrigger asChild` on one element — Radix's
  composed refs infinite-loop. Floating content (menus, popovers, tooltips) keeps
  `collisionPadding` 8.
- **Checkbox / Radio / Switch** — checked state = **ink fill with the canvas-colored
  glyph** (`bg-primary` + `text-primary-foreground` / `bg-primary-foreground` thumb
  contrast per control); unchecked wells `bg-secondary` with `border-input`.
- **Tabs** — `line` variant underline `after:bg-primary` (the one **ink** selected state —
  an underlined tab is nav-like); `default` filled variant stays a neutral `bg-muted`
  wash (the active segment lifts onto `bg-background` in light / `bg-accent` in dark).
  `TabsList size="sm"` is the compact segmented control (h-7, text-xs) — call sites never
  re-derive their own small tabs.
- **Toggle / Toggle-group** — pressed = neutral wash (`bg-accent`), never the accent.
- **Card** — `bg-card rounded-xl border` (border = hairline). Lifts off the paper canvas
  by a fill step + soft shadow in light; by the surface step + hairline in dark (no
  shadows in dark).
- **Avatar** — image avatars get `outline-1 -outline-offset-1 outline-foreground/10`; the
  base initials fallback is **neutral** (`bg-muted text-muted-foreground`). Identity-tint
  fallbacks are caller-owned (the allow-listed palette from `avatar-tints.ts`, initials
  in `text-scrim-foreground` over the tint) — do not bake tints into the primitive. The
  account/workspace pod applies a soft **ink** tint (`bg-primary/10 text-primary`), never
  a solid ink block. `AvatarBadge` tone is caller-owned: `bg-success` for presence,
  `bg-primary` (ink) only when the dot means "unread."
- **Sonner** — toasts on `popover` surface tokens; status icons `text-success` /
  `text-warning` / `text-destructive`; loading glyph is the house Spinner (decorative —
  the live region announces). `toast` is imported from `ui/sonner.tsx`, never from
  "sonner" (biome-enforced): the house layer makes error toasts linger 8s. Toasts never
  carry interactive-only affordances.
- **Skeleton / Separator / Label / Input-group** — retokened, no recipe surprises.
  Skeleton doctrine: blocks are `aria-hidden` (baked into the primitive); the loading
  REGION announces via `role="status"` + sr-only "Loading…" text — never rely on
  `aria-busy`. InputGroupButton sizes are local to the h-8 well (its `sm`/`icon-sm` are
  h-7/size-7 — not Button's scale).
- **Icon** (`components/icons.tsx`) — defaults to 16 and bakes in `aria-hidden`: glyphs
  are always decorative; the control's label carries meaning.

## Component recipes (shared/ + chrome)

- **EmptyState** — no container, no dashed border: icon `size-6 strokeWidth={1.75}` in a
  faint ink tint (`text-primary/70`), a one-line **voice headline** (`font-serif` — the
  Geist alias — `text-xl font-medium tracking-tight text-balance`), `text-pretty`
  supporting line, ONE plain action.
- **StatusPanel** — `bg-<tone>/10 ring-1 ring-inset ring-<tone>/25`; tones: neutral,
  brand, success, warning, danger (brand = the soft **ink** tint `bg-primary/10
  ring-primary/25 text-primary`, for brand moments — the ink accent is not a status). Two
  layouts: `center` (page-level states) and `inline` (left-aligned callouts — warning
  banners, token reveals, form errors: icon + title + body + one plain action). `danger`
  announces as `role="alert"`; other tones are polite `role="status"`. Never re-implement
  the tone grammar inline.
- **ConfirmDialog** (`shared/confirm-dialog.tsx`) — the one destructive-confirm surface:
  title, description, verb-labeled confirm (soft `destructive` fill), `ghost` Cancel.
  Initial focus lands on Cancel (Enter can't destroy by reflex); Esc/outside-click won't
  close mid-confirm. Every Remove/Delete/Take down goes through it.
- **FormField** — label + control + hint/error, WIRED: the message gets an id and a
  single-element child is cloned with `aria-describedby` (+ `aria-invalid` while an error
  shows). Errors are `text-destructive`.
- **SettingRow** (`shared/setting-row.tsx`) — a single setting as a horizontal
  label-left / control-right row (a toggle or select on the line). The counterpart to
  FormField's stacked layout: SettingRow for a one-line setting, FormField for a text
  input (their docstrings cross-reference each other, so neither is re-rolled inline).
- **SettingsGroup** (`shared/settings-group.tsx`) — a hairline-divided container grouping
  related SettingRows / list rows within a settings section, so a section's rows read as
  one set instead of loose lines.
- **AvatarPicker** (`shared/avatar-picker.tsx`) — the avatar upload control (onboarding +
  Settings › Profile): the current avatar (image, else identity-tint initials) with an
  upload affordance; hands the chosen `File` up. One control so both surfaces can't drift.
- **RoleSelect** (`shared/role-select.tsx`) — the workspace/share role picker over the
  shadcn Select — the canonical `ROLES` list with sentence-case labels; exports
  `ROLE_LABELS` so read-only surfaces (ShareDialog's member rows) render the same casing.
- **SearchField** (`shared/search-field.tsx`, on InputGroup) — the one search/filter
  field: search-icon scent, scoped placeholder, in-field Spinner while an async lookup is
  in flight, one cross-browser clear ✕ (native WebKit cancel suppressed), Esc clears then
  blurs. Placeholder grammar: client-side narrowing says "Filter …", server discovery says
  "Search …". Keyboard: ⌘K is the palette, "/" focuses the page's ONE `hotkey` SearchField
  (app-shell owns the listener; falls back to the palette on pages without one) — the Kbd
  "/" hint rides the empty field. Never compose a bare Input into a search bar.
- **Eyebrow** (`shared/section-eyebrow.tsx`) — the mono smallcaps micro-label register (`font-mono
  text-2xs font-medium uppercase tracking-wide text-muted-foreground`), `as` + `className`
  passthrough. The ONE compliant use of uppercase; **medium** weight keeps 10px caps legible while
  muted keeps it quiet — and matches the stock menu/select/command group labels, so the register
  reads identically everywhere. Use `Eyebrow` for card step-labels, popover section headers, and
  inline dividers instead of re-typing the class string.
- **SectionEyebrow** — `Eyebrow` **re-inked to `text-foreground`** (a section header should be
  seen) + tabular count (kept muted) + hairline rule to the edge. The section-level header; pairs
  with **PageHeader**, the page-level one.
- **SectionTitle** (`shared/section-title.tsx`) — the quiet **sans** sub-block heading (`text-sm
  font-medium text-foreground` `<h3>` + optional right-aligned `action`): for control/card
  sub-groups nested inside a section (Settings "Role"/"Discoverability"/"Slack", a card title)
  where the mono eyebrow reads too technical. The warm counterpart to `SectionEyebrow`'s mono.
- **LabeledDivider** (`shared/section-eyebrow.tsx`) — a label centered between two hairline rules
  (the login "or", a mid-page voice break). Owns only the flanking-rule layout; pass the label in
  whatever register fits (a mono `Eyebrow`, a voice `<h2>`), so nothing hand-rolls the two-sided
  `<Separator className="flex-1" />` pair.
- **Count** (`shared/section-eyebrow.tsx`) — the machine-register count beside a label
  ("Members · 12"): mono `text-2xs` tabular muted, led by an aria-hidden middle dot (SRs read just
  the number). `SectionEyebrow` bakes the same in; use `Count` for standalone label + count rows.
- **PageHeader** (`shared/page-header.tsx`) — the ONE page title band, so screens stop
  diverging: an optional mono `Eyebrow`, the title in the house **voice** (`font-serif`
  alias + `text-2xl font-medium tracking-tight text-balance`), an optional muted subtitle,
  and an optional right-aligned `actions` cluster that drops below the title under `sm`.
  Every content screen leads with it (People/Settings adopted it over their old `text-2xl
  font-semibold` sans; the Library greeting + Profile name are the same register). Pure
  header — the page owns what follows (search, tabs, results). Compose as PageShell's first
  child; the page's one voice headline (no second serif h2 stacked under it — the home's
  publish launcher is a quiet labelled bar, not a competing heading).
- **Spinner** — token ring (`border-border`) with a `border-t-primary` **ink** head.
- **State grammar** — a transient fetch error is *status*, not emptiness: it goes through the
  ONE grammar — `StatusPanel tone="danger"` + a quiet "Try again" (no filled primary on a
  failure) — never a bare `EmptyState`. This holds at every level: inline section failures
  (library/people/profile), **route-level** failures (`RouteError`), and the **artifact**
  load error all render a centered `StatusPanel`, not three hand-rolled treatments; `RouteNotFound`
  is the same chassis at `tone="neutral"`. Next-page/"loading more" affordance is a centered
  `Spinner` (`flex justify-center py-2`), never a text row.
- **Thumb** — the live-render preview and hero of every artifact card: a lazy, scaled,
  sandboxed iframe of the artifact's current version, with an inset hairline outline that
  brightens on the card's hover/focus and a resting dim (`brightness-[0.96] saturate-[0.98]`)
  that wakes to full — a `filter`, never a transform (a translating iframe repaints, which is
  why cards never lift). ONE scrim-backed machine-register placard rides the bottom-left
  (`bg-scrim/85 text-scrim-foreground`, the fixed Axiom-Black-on-Origin-White pair, both
  themes): the type, plus the version when there's history — `HTML · v3`, one chip not a
  badge per fact. Consumed full-bleed at the top of the card (no mat), the caption divided
  off by a `border-border-soft` hairline.
- **App shell** — sidebar-first: there is **no global desktop top bar**; the nav rail is
  the only persistent chrome and pages own their own headers (a page's header is the top
  edge of its floating content card). The shell is the shadcn `inset` variant — rail =
  recessed `bg-sidebar` backdrop, content = a rounded card floating on it. The wordmark
  lives in the rail header — the `Logo` mark (`currentColor`) + `<span class="font-serif
  text-lg font-medium tracking-tight">Derive</span>` (`font-serif` = the Geist alias). On
  mobile a sticky `MobileTopBar` (`bg-background/95 border-b`, hamburger + page label +
  search) stands in for the hidden rail; the inset collapses below `sm` (640px — the
  app's one mobile breakpoint, in lockstep with the rail; mobile is full-bleed).
- **Nav rail** — the OFFICIAL shadcn sidebar (`ui/sidebar.tsx`, consuming the `--sidebar-*`
  tokens) run as `variant="inset"` — the rail is a **recessed backdrop**, not a flush panel.
  `SidebarProvider` in app-shell owns open/collapsed (persisted via
  `STORAGE_KEYS.navCollapsed`, toggled by ⌘B + the header trigger), `collapsible="icon"`
  collapses to a 3rem icon strip on desktop, and mobile renders the whole rail in the
  component's off-canvas Sheet. Anatomy: `SidebarHeader` (wordmark + trigger + ⌘K launcher)
  → `SidebarContent` (menu groups; utilities pinned with `mt-auto`) → `SidebarFooter`
  (UserPod on a `SidebarMenuButton size="lg"`). Row grammar (baked into `ui/sidebar.tsx`,
  not overridden at call sites): every row carries ONE constant weight (`font-medium` — the
  nav rule forbids a weight change between default/hover/active), with inactive rows dimmed
  (`text-sidebar-foreground/70`, icons riding the same muted ink) so the rail recedes and
  the current page stands out; hover is the neutral `bg-sidebar-accent` wash + a re-ink to
  full ink. The **active row is a raised chip** — the card surface (`bg-card`) + a
  `ring-sidebar-border` hairline lift off the recessed rail; **no shadow and no weight
  change** — the surface step + the re-ink carry the selection, no colored tick and no
  accent edge (the only ink in the rail is still the notification unread dot and the sync
  chip). Rows are `rounded-lg` with the **ink** inset focus outline; `SidebarGroupLabel` is
  the mono 2xs uppercase eyebrow; `SidebarMenuBadge` is `font-mono text-2xs tabular-nums`,
  muted by default (a rail count is not an ink moment), rendered only when nonzero.
- **UserPod** — the account menu at the rail foot, on the app's ONE menu primitive (a real
  `DropdownMenu` — roving focus, `role=menu`, arrow-key nav, typeahead — not a hand-rolled
  popover of look-alike rows). Initials avatar in a soft **ink** tint (`bg-primary/10
  text-primary`). Four zones top→bottom: identity (avatar + name + public handle) · account
  (View profile, Settings) · context (the workspace switcher when you're in more than one,
  then the segmented Theme control — a Tabs, so toggling it doesn't dismiss the menu) · a
  set-off Sign out (muted; focus re-inks). Separators bracket only the unlabelled breaks
  (after identity, before sign out); the mono Workspace/Theme labels divide their own sections.
- **NotificationBell** — unread signal = `size-1.5 rounded-full bg-primary` **ink** dot
  (in both the collapsed strip and the expanded rail); the count badge beside it stays
  neutral (`text-muted-foreground`), like every other sidebar count.
- **SyncChip** — a soft **ink**-tinted chip (`border-primary/30 bg-primary/5`, hover `/10`)
  — a sanctioned brand/machine moment (a running sync = "this matters"); its progress bar
  and spinner head ride `bg-primary` / `border-t-primary` ink.
- **Mentions** (globals.css `.mention`, `.mention-live`) — a RENDERED mention is a
  **solid ink tag**, not a soft chip: a full `--primary` fill with `--primary-foreground`
  text at weight 700, so a tagged person can't miss it (and with a monochrome accent
  there's no CTA fill for it to clash with). The LIVE composer tag (`.mention-live`) is
  different by necessity: the field's own text is the visible text (the caret must never
  detach from what you read — see MentionField), so the overlay can only paint a box
  *behind* foreground-colored glyphs — a soft ink tint (`color-mix` ~15% primary), which
  a solid fill would swallow. The tag takes its full pill the moment it's posted.
- **Artifact header** — the workbench top bar is an identity-led *document header*, not an
  action row. The left leads with the artifact title (`font-serif`) over a machine-register
  state line (`{TYPE} · v{n} · updated {ago}`, mono `text-2xs` muted) — the bar states WHAT
  you're viewing and its state, the thing a row of icons never did. The right side is three
  clusters separated by **space, not rules** — no floating vertical hairlines (group the
  Linear way, with spacing + alignment): the ambient **presence** cluster (the facepile — the
  live-cursor layer needs no control of its own), then the **actions** — the ONE filled-ink
  **Share** leads as the page's single primary (everything else ghost), then the favorited
  **star** (glanceable ink state), then a single sectioned **⋯** (view modes → organize →
  activity → manage; Tags & Collections open as dialogs from it) — then the terminal
  **Comments** toggle hugging the panel it opens. Everything that used to crowd the row
  (Present / Insights / History / Proposals / Edit / Lock / Report / Tags / Collections) now
  lives behind the ⋯ — the render is the hero, the chrome recedes.
- **Live cursors** — peers' cursors are a slim arrow tinted by their **identity**: a stable,
  distinct tint from the shared identity palette (`colorForName`, the same palette avatar
  tints draw from), keyed on the server-stamped handle that also names them in presence.
  Color follows the person — one tint per peer for the session, never a per-cursor pick — with
  a `font-medium` name flag that fades on stillness. The identity tint stops at the cursor **on
  purpose**: a cursor *moves*, so color pre-attentively separates two arrows scrubbing at once
  (the name tag confirms). The presence facepile and comment avatars are static and already
  name-labeled — they read you-vs-them in `primary`/`accent` and stay calm; painting them with
  8 identity tints would add persistent color to the view's busiest surfaces for a match nobody
  needs at 2–3 concurrent viewers. So the tint earns its keep here and nowhere else. There is no
  style selector: a picker of colors + emoji would break both *color is rationed* and *never emojis*.
  The one real preference — **Hide live cursors** — is a checkbox item in the ⋯ menu's view-
  modes group beside Focus; it opts you out of the whole layer (peers vanish, yours stops
  broadcasting) and persists per-browser like the theme.

## Voice

Buttons are verbs: Open, Pin, Approve, Delete, Upgrade. Empty states have a one-line voice
headline (Geist) + one plain next action, never a bare "No artifacts yet." Errors go
through toasts (never `alert()`); destructive confirms via the shared `ConfirmDialog`
(never `window.confirm()`). Busy buttons keep their verb ("Saving…", never a bare "…").
Sentences and standalone descriptions end with a period; list items don't. Never emojis.

## Engineering guardrails (CI-enforced)

- `scripts/check-design-tokens.mjs` — no raw hex/rgb/palette classes/arbitrary sizes
  outside `styles/globals.css` + allow-list. All new color enters through tokens.
- `scripts/check-testids.mjs` — every interactive control in `pages/` + `shared/` keeps a
  `data-testid`. Do not drop them while restyling.
- `scripts/check-frontend.mjs` — storage keys only via `STORAGE_KEYS`.
- Biome formatting; `pnpm --filter @derive/web typecheck` must pass.
- Layout: `gap-*` between flex/grid children (never child margins); `size-*` over `h-*
  w-*`; `min-w-0` on shrinking flex children, `shrink-0` on icons/avatars; `role="list"`
  on unstyled `ul`/`ol` — NOT redundant here: Tailwind's `list-none` reset drops list
  semantics in Safari/VoiceOver, which is why Biome's `noRedundantRoles` is off in
  biome.json; container queries for width-responsive widgets; every layout adapts mobile →
  desktop.
