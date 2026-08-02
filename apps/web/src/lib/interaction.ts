/**
 * The interaction register: one spelling each for the states every row, card and
 * nav item shares. Compose with `cn()`.
 *
 * Colour and type each have one home already (the globals.css tokens, `Eyebrow`).
 * Interaction didn't, so it drifted — four spellings of "reveal on hover" across
 * five call sites, and a selection state that lost to hover. Both were visible to a
 * reader, so the rules are written down here rather than left to be re-derived.
 *
 * ## Selection outranks hover
 *
 * Tailwind compiles `data-active:bg-card` to
 * `.data-active\:bg-card:where([data-active]:not([data-active=false]))`. The
 * `:where()` wrapper contributes ZERO specificity, so that rule is (0,1,0) — while
 * `hover:bg-x` is `.hover\:bg-x:hover`, which is (0,2,0). Hover therefore beats any
 * `data-*` state regardless of the order the classes are written in or the order
 * Tailwind emits them. The sidebar shipped this way: pointing at the page you were
 * already on repainted its raised chip with the same grey as an idle row, so the
 * current page read as unselected exactly when you pointed at it.
 *
 * Fix by scoping the hover rather than fighting the cascade — `not-data-active:`,
 * which is what {@link ROW_HOVER} does. Use the same shape for any other state that
 * has to lose to a selected one.
 *
 * ## Reveal is one thing
 *
 * A control that appears on hover has three other cases to answer, and hand-spelling
 * it got a different one wrong each time: keyboard users need it revealed by focus
 * ANYWHERE in the row (`group-focus-within` — a control's own `focus-visible` means
 * an invisible thing you can only see once you've already tabbed onto it), touch has
 * no hover at all (`pointer-coarse`), and reduced-motion users shouldn't get a fade.
 *
 * Tailwind resolves variants from literal class names at build time, so the trigger
 * classes can't be templated per group — hence one constant per group scope, each
 * built on the shared {@link STATE_MOTION}.
 */

/**
 * Motion for a state change: fast enough to read as a response rather than an
 * animation, and off entirely when the reader asked for that.
 */
export const STATE_MOTION = "transition-opacity duration-state motion-reduce:transition-none"

/**
 * A control that rests hidden and appears when its row is hovered or focused — a
 * row's ⋯ menu, its star, its select box. Requires `group` on the row.
 *
 * Opacity only, never `hidden`/`invisible`: those drop the control out of the
 * layout, so the row reflows under the cursor at the moment you reach for it.
 */
export const REVEAL = `opacity-0 ${STATE_MOTION} group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100`

/** The visible half of {@link REVEAL} — on, and still transitioning in step. */
export const REVEAL_PINNED = `opacity-100 ${STATE_MOTION}`

/**
 * {@link REVEAL}, resolved. `pinned` is the reason this control is exempt from
 * hiding: it's starred, it's selected, or something else in the view is.
 */
export const reveal = (pinned: boolean) => (pinned ? REVEAL_PINNED : REVEAL)

/**
 * {@link REVEAL} for a trigger that must also stay put while its menu is open.
 * Radix reports that as `aria-expanded`, not React state, so it can't go through
 * {@link reveal}.
 */
export const REVEAL_MENU = `${REVEAL} aria-expanded:opacity-100`

/** {@link REVEAL} for a row that names its group (`group/folder`) because it nests. */
export const REVEAL_IN_FOLDER = `opacity-0 ${STATE_MOTION} group-hover/folder:opacity-100 group-focus-within/folder:opacity-100 pointer-coarse:opacity-100`

/** {@link REVEAL} for a `group/menu-item` row — the sidebar's own row scope. */
export const REVEAL_IN_MENU_ITEM = `opacity-0 ${STATE_MOTION} group-hover/menu-item:opacity-100 group-focus-within/menu-item:opacity-100 pointer-coarse:opacity-100 aria-expanded:opacity-100`

/** {@link reveal}, for a `group/folder` row. */
export const revealInFolder = (pinned: boolean) => (pinned ? REVEAL_PINNED : REVEAL_IN_FOLDER)

/**
 * The hover wash for a row that can also be the current one. Scoped to
 * `not-data-active` so the selection survives the pointer — see the note above.
 */
export const ROW_HOVER =
  "not-data-active:hover:bg-sidebar-accent not-data-active:hover:text-sidebar-accent-foreground"

/**
 * The plate a control gets when it floats over content it doesn't own — an action
 * button over an artifact render, a select box over a screenshot. Shared so the
 * cluster that appears on hover reads as one set of controls rather than a bare
 * checkbox in one idiom and outlined buttons in another.
 */
export const OVER_CONTENT = "border border-border-soft bg-card shadow-(--shadow-sm)"
