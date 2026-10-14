---
name: derive-polish
description: Build, polish, and grade Derive web UI (apps/web) to a high-end, calm, editorial bar. Use for any new or changed screen, form, row, empty state, or mockup in the Derive app, and before calling UI work done.
---

# derive-polish

Derive should feel like a well-set magazine run by Linear: calm, precise, ink on paper. This
skill is how a screen gets there and how you prove it. `docs/design-system.md` is the source
of truth for tokens, type, radius, focus, motion, icons and voice. Read the sections you touch;
this file adds the bar, the gates and the loop, and does not restate them.

## The reference surfaces

Match these before inventing anything. When a new screen disagrees with them, the new screen
is wrong.

- **Agent page → Settings** (`pages/agents/agent-settings.tsx`): label/value rows (`Field`),
  quiet `Verb` actions on the right, `Sub` grey lines only where a value needs explaining,
  `Segmented` for small exclusive choices, `Group` for sections.
- **Task page** (`pages/agents/task-page.tsx`, `task-run.tsx`): steps, facts, activity feed.
- **Inbox rows** (`pages/agents/inbox.tsx`, `rows.tsx`): two lines, title then one-line gist.

Reuse their components. A second way to show the same kind of thing is a defect.

## Hard gates (any FAIL means the screen is not done)

1. **Tokens only.** No raw hex, palette classes or arbitrary sizes (`pnpm lint:tokens`).
2. **One filled primary button per surface.** Everything else is secondary, ghost or a `Verb`.
3. **No dropdowns or selects in page headers or top bars.** Use visible segments or chips.
4. **Same thing, same component, same interaction** across the app (rows, chips, forms,
   empty states, confirms).
5. **Nothing hides on hover.** Hover adds; it never reveals the only way to do something.
6. **Every state is designed:** empty, loading (`Skeleton`), error (toast + inline where it
   blocks), saving (busy verb: "Saving…"), disabled-with-reason, and read-only for people
   who can't manage it.
7. **Light and dark both pass**, and the screen works at 390px wide with no horizontal scroll.
8. **Every interactive control keeps a `data-testid`** (`pnpm lint:testids`).
9. **Copy:** buttons are verbs, sentences end with a period, no emojis, no jargon the person
   didn't type (say "New commits", not `synchronize`).

## The loop

1. **Scenario map first.** List every state the screen can be in (new, filled, many, error,
   paused, no permission, setup still needed, mobile). Each one gets a screenshot later.
2. **Build from the reference components.** Reach for `Field`, `Verb`, `Sub`, `Segmented`,
   `Group`, `ToggleGroup`, `Input`, `Textarea`, `Badge`, `EmptyState`, `ConfirmDialog`
   before writing new markup. New shared pieces go in `components/shared/`.
3. **Run it for real.** Start the API and web locally (`.claude/skills/verify`, then
   `pnpm dev:web`), seed the states through the API, and open them in the browser this
   machine allows (Aside `aside repl` here). Never grade from code alone.
4. **Screenshot every scenario** in light and dark, desktop and narrow, and save them with
   the change (PR body or a Derive page).
5. **Grade with the rubric below. Fix and reshoot until it scores 90 or more** with every
   hard gate passing. Stop each pass, look at the screenshots, and name what a careful
   designer would still change.

## Rubric (100)

| Area | Points | What full marks looks like |
|---|---|---|
| Hierarchy | 20 | One thing to read first; label, value, then explanation; nothing competes with the primary action |
| Rhythm and density | 15 | Even gaps from the spacing scale; aligned baselines and left edges; no orphan lines or ragged rows |
| Consistency | 15 | Same components and grammar as the reference surfaces; same words for the same things |
| Copy | 15 | Plain verbs, sentences that explain why, human names for machine values, no truncation that hides meaning |
| States | 15 | Every scenario in the map is designed and shown, including errors and setup-needed |
| Craft | 10 | Focus rings, tabular numbers, icon sizes from the three steps, instant color changes, `active:translate-y-px` |
| Mobile and dark | 10 | 390px and dark mode read as designed, not as leftovers |

Report the grade as a table with one line per area: the score and the single biggest fix left.
