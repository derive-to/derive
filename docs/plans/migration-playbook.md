# Component Migration Playbook (parallel agents)

Convert one **surface** from legacy hand-rolled CSS to Tailwind v4 + shadcn `ui/`.
Outcome bar: tokenized (all 4 themes), accessible (Radix), responsive (mobile),
`data-testid`'d, and proven by a Playwright spec.

## Read first (10 min)

- `docs/plans/component-migration-floor-plan.html` — scope, LOC targets, file-split shape.
- `src/components/ui/*` — the primitives you compose. **Do not modify.** Always prefer these over hand-rolling.
- `src/components/shared/*` — domain atoms: `Thumb`, `EmptyState`, `Spinner`, `RoleSelect`.
- `src/styles/globals.css` — the token bridge (semantic Tailwind colors → theme vars).
- `src/styles.css` — legacy CSS. Read it for the `[data-theme]` palettes and the exact class you're replacing.
- **Reference conversions** (copy these patterns): `pages/library/*`, `components/{header,user-menu,notification-bell,toast}.tsx`, `e2e/chrome.spec.ts`.

## Rules

1. **Compose, never hand-roll.** Use `ui/` (Button, Card, Input, Dialog, Popover, DropdownMenu, Avatar, Badge, Tooltip) + `shared/`. All `ui/` is canonical shadcn (`forwardRef` + `displayName`) — keep it that way if you add one.
2. **Tokens only.** Color via semantic utilities (`text-foreground`, `bg-card`, `border-border`, `text-primary`) — **no `#hex`, no `var(--x)` inside `.tsx`**. Type only `text-2xs … text-3xl` — no `text-[13px]`, no inline `fontSize`. Spacing via the scale. (Only exception: a genuinely dynamic data-driven value, e.g. a per-row swatch color, may use `style`.)
3. **Accessible.** Every interactive element is a Radix primitive or a real `<button>`/`<a>`. Icon-only buttons get `aria-label`; inputs get a label or `aria-label`. Radix gives focus trap / keyboard / roles for free.
4. **Responsive.** Mobile-first utilities; verify at 390px. `useIsMobile()` (640 = Tailwind `sm`) for JS branches.
5. **`data-testid` on every actionable/assertable element.** kebab, surface-scoped: `settings-save`, `share-add`, `artifact-comment-submit`. Dynamic: `` `member-row-${id}` ``. This is how automation stays reliable — never depend on text/role/nth.
6. **Split** the file into `pages/<surface>/` (or `components/<surface>/`) modules, each under ~400 LOC.
7. **Don't touch** `ui/`, `components/shared/`, `globals.css`. **Don't delete from `styles.css`** — just stop using the classes. (Legacy-CSS removal is a single final consolidation pass, to avoid merge conflicts.) Need a new shared atom? Add it under `components/shared/` with a clear name.

## Dev stack (your own, isolated — never use someone else's ports)

Dock is `apps/api` (Hono) + `apps/web` (vite SPA, proxies `/v1`,`/api`,`/raw`,`/healthz` → API). Pick unique ports.

```bash
# API (fresh SQLite, isolated data dir)
cd apps/api && PORT=8200 DATA_DIR="$PWD/.data-mine" \
  DOCK_WEB_ORIGIN=http://localhost:3200 BASE_URL=http://localhost:3200 pnpm dev

# Web (HMR), proxying to your API
cd apps/web && DOCK_API=http://localhost:8200 pnpm exec vite --port 3200 --strictPort
```

Sign up fresh (first user on a fresh DB = workspace owner). Switch theme with
`localStorage.setItem('dock_theme','dark'|'light'|'paper'|'dusk')` then reload;
`<html data-theme>` reflects it.

## Verify (gate for "done")

- `pnpm typecheck` (root or `apps/web`) — clean.
- `pnpm exec biome check --write <your files>` — clean.
- **Playwright spec** `e2e/<surface>.spec.ts` using `page.getByTestId(...)` + the `signUp` / `publishArtifact` helpers in `e2e/helpers.ts`. Run `cd apps/web && pnpm exec playwright test e2e/<surface>.spec.ts` — green. (It boots its own throwaway servers.) **Parallel agents: pick distinct e2e ports** — `PW_WEB_PORT=339X PW_API_PORT=839X pnpm exec playwright test …` — otherwise `reuseExistingServer` makes your run hijack another worktree's dev server and fail spuriously.
- Screenshot the surface in **all 4 themes + mobile (390px)** against your dev stack.

> Playwright drives Radix correctly (real pointer events). `agent-browser` is fine
> for screenshots but does **not** reliably trigger Radix menu/popover selection —
> use Playwright + test-ids for any interaction assertions.

## Ship

- Own worktree + branch off `main` (after PR #53 merges; before that, branch off `feat/tailwind-shadcn`): `feat/migrate-<surface>`. Run `bash scripts/setup-worktree-env.sh && pnpm install`.
- Commit identity `agarwal.anir@gmail.com`. Product-only (no external references in code/commits).
- Branch → PR. The surface's Playwright spec must be green.

## Surfaces (claim exactly one)

| Surface | File | LOC | Notes |
|---|---|---|---|
| Login | `pages/Login.tsx` | 158 | Card + Input + Button; add test-ids; update `e2e/helpers.ts signUp` to use them |
| ShareDialog | `components/ShareDialog.tsx` | 200 | Rebuild on the Dialog primitive; reuse `RoleSelect` |
| Settings | `pages/Settings.tsx` | 909 | Split into `pages/settings/` by section; Tabs/Card/Input |
| ReviewOverlay | `components/ReviewOverlay.tsx` | 608 | Convert + split overlay/diff/controls |
| Artifact | `pages/Artifact.tsx` | 3445 | The big one → `pages/artifact/` (header, version-rail, content/*, comments/*, insights→Popover); extract `ColoredAvatar`, `KindBadge` to `shared/` |
