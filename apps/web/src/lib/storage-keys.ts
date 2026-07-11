// Every localStorage / sessionStorage key in one place, so a key can't be
// typo'd, duplicated, or drift out of the `derive` namespace. Enforced by
// scripts/check-frontend.mjs: storage may only be keyed by a member of this
// object, never a bare string literal.
export const STORAGE_KEYS = {
  theme: "derive_theme",
  cursorPref: "derive.cursor.pref",
  commentsPanel: "derive.comments.panel",
  navCollapsed: "derive.nav.collapsed",
  // A per-browser, NON-authoritative hint of the last resolved session's signed-in
  // state — steers only the pre-paint boot frame (rail vs chrome-light) so a returning
  // user's cold load doesn't pop. Never an access decision (see lib/auth-hint).
  authed: "derive.authed",
  // Agent pushes auto-open in this tab (absent = on). Per-device on purpose:
  // yanking navigation is fine on your own laptop, hostile on a shared screen.
  autoOpen: "derive.autoopen",
  // Legacy literals (the colon convention predates the dot switch) — kept as-is so a
  // saved onboarding flag / folder pref survives the rename.
  onboarded: "derive:onboarded",
  libraryFolders: "derive:show-folders",
  // Dismissal of the home's one-time "set up your team's Brandprint" nudge (owners
  // of a Brandprint-less workspace; see pages/library/brandprint-nudge).
  brandprintNudge: "derive:brandprint-nudge",
} as const
