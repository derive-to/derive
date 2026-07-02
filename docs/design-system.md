# Derive Design System

The visual identity ported from Nemonic (`docs/design-system.md` there is the ancestor
document), rebuilt on Derive's stack: Vite + React 19 + TanStack Router + Tailwind v4 +
shadcn/Radix. Dark is the canonical brand; light is a first-class derivation (Nemonic
never had one). This file is the source of truth for every component in
`apps/web/src/components` and every page in `apps/web/src/pages`.

## Personality

Editorial, calm, precise. Closer to a well-set magazine or Linear than to a busy SaaS
dashboard. Serif for moments of voice (greetings, artifact titles, empty-state
headlines), a clean grotesque (Inter) for the working UI, mono for the machine-facing
layer (counts, versions, timestamps, kbd). Charcoal, never pure black; off-white, never
pure white. Amber is the one warm note — used sparingly, so it always means "this
matters."

## Color

All color flows through the semantic tokens in `apps/web/src/styles/globals.css`.
Components never use raw palette classes (`bg-zinc-*`, `text-amber-*`) — the token
linter (`scripts/check-design-tokens.mjs`) enforces this outside `components/ui/**`,
and `ui/` holds itself to the same standard voluntarily.

### The ramps (defined once in globals.css)

- **Charcoal neutrals** (cool, hue ≈ 268): canvas `#0b0d12`, raised `#13161d`,
  floating `#1b1f29`, text `#ececef` (the "white" — never `#fff`), secondary text
  `#9ca3b5`, decoration-only `#3b4150`.
- **Brand — honey amber**, core `#e99421` (`brand-500`). Full ramp available as
  `--color-brand-50…950` for soft chips (`bg-brand-500/10 text-brand-300` in dark).
- **Success** green, **warning** safety-orange `#f97316`-family (deliberately a
  different hue family from brand amber, so alerts never read as brand notes),
  **destructive** red. One per-theme token each (`--success`, `--warning`,
  `--destructive`); derive fills/edges with opacity modifiers (`bg-success/10`,
  `ring-warning/25`).

### Semantic assignments — dark (canonical)

| Token | Value | Role |
|---|---|---|
| `background` | `#0b0d12` | app canvas; the shell (top bar, nav rail) is FLUSH on it |
| `card` | `#13161d` | raised surfaces: dialogs, command palette, cards that must lift |
| `popover` | `#1b1f29` | floating surfaces: menus, popovers, tooltips, toasts |
| `primary` / `primary-foreground` | `#e99421` / `#0b0d12` | amber; **text on amber fills is always the canvas charcoal, never white** (white-on-amber fails contrast) |
| `secondary` | `white/5` | quiet fills: secondary buttons, input wells |
| `muted` / `muted-foreground` | `white/8` / `#9ca3b5` | skeletons, kbd fills / secondary text |
| `accent` | `white/10` | menu keyboard-focus + hover fill (neutral — never amber) |
| `border` / `input` | `white/10` / `white/15` | every edge is white-at-an-opacity so it composites identically over canvas, cards, and wells; a bare `border` is the standard hairline |
| `ring` | `#e99421` | focus is always amber, never blue |
| `destructive` | `#f87171` | soft-fill legible red |
| shadows | `0 0 #0000` | **no shadows in dark** — elevation is a surface step plus a `ring-1 ring-foreground/10` edge |

### Semantic assignments — light (derived, net-new)

Keep the cool cast (same hue family, low chroma) and keep amber the one warm note, but
darkened for contrast: bright `#e99421` fails AA as text on light grounds (2.4:1), so
light-mode primary is bronze `#a15a16` (brand-700, 4.8–5.3:1) with `ring` at brand-600
`#c87516`. Canvas, cards, and popovers are all white — a deliberate deviation from a
tinted-paper canvas: light surfaces separate by hairline edge + shadow instead of a
fill step (content sits directly on white; a gray canvas under white cards is the
pattern the surface rules warn against, and login pages must never sit on a tinted
ground). Ink is the dark canvas charcoal `#0b0d12` (charcoal, never black); the cool
cast lives in the ink, edges, and muted text rather than the canvas. Edges are
ink-at-an-opacity (mirroring the dark grammar). Light mode KEEPS soft shadows — the
no-shadow rule is dark-only.

### Amber deployment rules (the discipline that makes it work)

Amber is reserved for: **primary actions, active-nav indicator, focus rings, links,
selected-tab underline, unread dots, and brand moments** (empty-state icon tint,
spinner head, sync chip). Everything else stays neutral:

- Selected filters, segments, toggle-groups, list rows: **white washes**
  (`bg-accent`, `bg-foreground/5`), never amber tints.
- Menu keyboard focus: `bg-accent`, neutral.
- One filled primary button per page/dialog. All other buttons are secondary/ghost.
- Warnings are `warning` orange, never amber. Status is `success`/`warning`/
  `destructive`; amber is not a status.
- On amber fills: charcoal text/glyphs (`text-primary-foreground`), never white.

## Typography

Three families, three registers (all self-hosted via fontsource; no external font
links):

| Register | Family | Used for |
|---|---|---|
| chrome | `Inter Variable` (opsz axis, features cv02 cv03 cv04 cv11 ss01 ss03) | all working UI: controls, labels, headings of tool surfaces, dialog/card titles |
| voice | `Source Serif 4 Variable` (weight 500, `font-serif`) | the wordmark, login/welcome headlines, empty-state headlines, artifact (content) titles — "the work", not the tool |
| machine | `Geist Mono Variable` (`font-mono`) | counts, versions, timestamps, kbd, uppercase micro-eyebrows |

Rules:

- Keep Derive's type scale (control base `text-sm` 14px, body `text-base` 16px,
  `text-2xs` 11px for mono micro-labels only). Never `text-xs` for body copy.
- Headings: `font-medium` or `font-semibold`, never `font-bold`; `tracking-tight`
  above `text-xl`; no `leading-*` overrides on headings; `text-balance` on headings,
  `text-pretty` on paragraphs.
- `uppercase` only on mono eyebrows, always with `tracking-wide` (the
  `SectionEyebrow` grammar).
- Numbers that change (counts, stats, timers): `tabular-nums`.
- Serif is applied per call-site (`font-serif font-medium tracking-tight`), NOT via
  `--font-heading` — chrome headings stay Inter.

## Surfaces, edges, elevation

- **Flush shell**: top bar and nav rail sit on `bg-background` separated by hairline
  `border-border` — no inset panels, one canvas.
- Cards only when content is independently interactive or must lift; prefer
  whitespace → hairline dividers → wells (`bg-secondary`) → cards, in that order.
- Floating elements (menus, popovers, dialogs, toasts): surface step + `ring-1
  ring-foreground/10`; shadows come from the theme shadow tokens (visible in light,
  zeroed in dark).
- Never solid-gray dividers; always opacity edges (`border-border`,
  `border-border-soft`).
- Images/screenshots/thumbnails: no borders — `outline-1 -outline-offset-1
  outline-foreground/10`.

## Radius

`--radius: 0.5rem`. Workhorse `rounded-lg` (8px) for buttons/inputs/menu items,
`rounded-xl` (12px) for menus/cards, `rounded-2xl` (pinned to 16px) for dialogs.
Concentric nesting: inner radius = outer radius − padding.

## Focus

- Clickables (buttons, links, menu triggers, nav rows):
  `focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring`
  — solid amber outline, offset.
- Editables (input, textarea, select trigger): `focus-visible:border-ring
  focus-visible:ring-2 focus-visible:ring-ring/40` — amber border + soft glow, no
  offset (never `outline-offset` on inputs).

## Motion

Fast and quiet. No hover color/background transitions — color changes are instant
(`transition-*` is reserved for elements that move, scale, or fade: dialog/popover
entrances via tw-animate-css, the sheet slide, toast rise). Entrance timing ≈ 200ms
ease-out. Active press: `active:translate-y-px` on buttons. Respect
`prefers-reduced-motion` (already globally handled in globals.css).

## Icons

**lucide-react only** (Phosphor is removed). `size-4` in app UI, `strokeWidth`
default; editorial/empty-state icons `size-6` with `strokeWidth={1.75}`. Always
`shrink-0` inside flex rows. Color via `text-*` utilities (lucide inherits
currentColor). Never wrap icons in decorative containers. Route shared icons through
`components/icons.tsx`; pages may import lucide directly for one-offs.

## Component recipes (ui/)

APIs, exported names, `data-slot` attributes, and `data-testid`s are stable — only the
visual recipes change. React 19 style (no forwardRef), `cn()` from `lib/utils`, cva
for variants.

- **Button** — variants: `default` (amber fill, charcoal text, subtle inset top-light
  `shadow-[inset_0_1px_0_--theme(--color-white/20%)]`, hover slightly lighter fill);
  `secondary` (`bg-secondary` + `border-input`, hover border brightens); `ghost`
  (hover `bg-secondary`); `outline` (hairline only); `destructive` (soft:
  `bg-destructive/10 text-destructive`, hover `/15` — confirm destructive intent via
  dialog, never a loud red fill); `link`. Two workhorse heights: `default` h-9 and
  `sm` h-8 (+ icon sizes). Buttons are verbs.
- **Badge** — flat rounded-md chips, no borders: `neutral` (`bg-accent
  text-foreground`), `brand` (`bg-primary/10 text-primary` dark-adjusted), `success`
  / `warning` / `destructive` (`bg-<tone>/10 text-<tone>`), `outline` (hairline).
  Icon-leading badges use asymmetric padding (`py-1 pr-2 pl-1`).
- **Kbd** — `font-mono text-2xs bg-muted` chip.
- **Input / Textarea** — `bg-input/20`-style quiet well on dark, hairline
  `border-input`, amber focus per Focus rules; invalid = `border-destructive`.
- **Dialog / Sheet** — overlay `bg-scrim/50`; panel `bg-card rounded-2xl ring-1
  ring-foreground/10`; 200ms entrance. Titles stay Inter (chrome).
- **Dropdown-menu / Popover / Select / Command** — `bg-popover ring-1
  ring-foreground/10 rounded-xl`; item focus/hover `bg-accent` (neutral); destructive
  items `text-destructive`; command palette panel on `bg-card`.
- **Tooltip** — surface style, not inverted: `bg-popover text-popover-foreground
  ring-1 ring-inset ring-foreground/10 rounded-md px-2 py-1 text-xs`, no arrow.
- **Checkbox / Radio / Switch** — checked state = amber fill with charcoal glyph
  (`bg-primary` + `text-primary-foreground`/`bg-primary-foreground` thumb contrast
  per control); unchecked wells `bg-secondary` with `border-input`.
- **Tabs** — `line` variant underline `after:bg-primary` (the one amber selected
  state — an underlined tab is nav-like); `default` filled variant stays a neutral
  `bg-muted` wash.
- **Toggle / Toggle-group** — pressed = neutral wash (`bg-accent`), never amber.
- **Card** — `bg-card rounded-xl border` (border = hairline). No shadows in dark.
- **Avatar** — image avatars get `outline-1 -outline-offset-1 outline-foreground/10`;
  identity-tint fallbacks unchanged (allow-listed palette); workspace/initials
  fallback is a SOFT brand tint `bg-primary/10 text-primary` (10%, not 15% — the
  light theme's bronze text needs the quieter tint to stay AA), never a solid
  amber block.
- **Sonner** — toasts on `popover` surface tokens; status icons `text-success` /
  `text-warning` / `text-destructive`.
- **Skeleton / Separator / Label / Input-group** — retokened, no recipe surprises.

## Component recipes (shared/ + chrome)

- **EmptyState** — no container, no dashed border: icon `size-6 strokeWidth={1.75}
  text-primary/70`, one-line serif headline (`font-serif text-xl font-medium
  tracking-tight text-balance`), `text-pretty` supporting line, ONE plain action.
- **StatusPanel** — `bg-<tone>/10 ring-1 ring-inset ring-<tone>/25`; tones: neutral,
  brand, success, warning, danger.
- **SectionEyebrow** — mono 2xs uppercase tracking-wide + tabular count + hairline
  rule to the edge (already the house idiom; keep).
- **Spinner** — token ring with `border-t-primary` amber head.
- **Thumb** — scrim placards (`bg-scrim/85 text-scrim-foreground`), outline frames,
  resting dim `brightness-[0.94] saturate-[0.96]`.
- **App shell** — top bar `bg-background border-b` (flush), serif wordmark: `Logo`
  mark (unchanged, `currentColor`) + `<span class="font-serif text-lg font-medium
  tracking-tight">Derive</span>`.
- **Nav rail** — `bg-background border-r` (flush), built on the `sidebar.tsx`
  primitives (Catalyst port): header → scrolling body (`p-4`, sections `gap-0.5`
  internally, `mt-8` apart) → pod-only footer. Row grammar (one source:
  `nav-row.ts`; `SidebarItem` composes it): rest labels are FULL-strength ink —
  only icons are muted, brightening on hover/current; the `bg-hover` wash is
  hover-only (transient) — the current row carries NO wash: state = the tick +
  icon ink. The current tick is a 2px `rounded-full bg-primary` bar at the
  sidebar's absolute edge (`-left` into the body's gutter). Counts `font-mono
  text-2xs tabular-nums`, rendered only when nonzero. No font-weight changes
  between states.
- **UserPod** — initials avatar soft brand tint; popover per menu recipe.
- **NotificationBell** — unread signal = `size-1.5 rounded-full bg-primary` dot.
- **SyncChip** — `border-primary/30 bg-primary/5` amber-tinted chip (a brand moment).
- **Mentions** (globals.css `.mention`, `.mention-live`) — soft chips:
  `color-mix(in oklab, var(--primary) 15%, transparent)` fill with `var(--primary)`
  text, weight 600 — not solid amber pills.

## Voice

Buttons are verbs: Open, Pin, Approve, Delete, Upgrade. Empty states have a one-line
serif headline + one plain next action, never a bare "No artifacts yet." Errors go
through toasts (never `alert()`); destructive confirms via dialog (never
`window.confirm()`). Sentences and standalone descriptions end with a period; list
items don't. Never emojis.

## Engineering guardrails (CI-enforced)

- `scripts/check-design-tokens.mjs` — no raw hex/rgb/palette classes/arbitrary sizes
  outside `styles/globals.css` + allow-list. All new color enters through tokens.
- `scripts/check-testids.mjs` — every interactive control in `pages/` + `shared/`
  keeps a `data-testid`. Do not drop them while restyling.
- `scripts/check-frontend.mjs` — storage keys only via `STORAGE_KEYS`.
- Biome formatting; `pnpm --filter @derive/web typecheck` must pass.
- Layout: `gap-*` between flex/grid children (never child margins); `size-*` over
  `h-* w-*`; `min-w-0` on shrinking flex children, `shrink-0` on icons/avatars;
  `role="list"` on unstyled `ul`/`ol`; container queries for width-responsive
  widgets; every layout adapts mobile → desktop.
