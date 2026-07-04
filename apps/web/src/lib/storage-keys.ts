// Every localStorage / sessionStorage key in one place, so a key can't be
// typo'd, duplicated, or drift out of the `derive` namespace. Enforced by
// scripts/check-frontend.mjs: storage may only be keyed by a member of this
// object, never a bare string literal.
export const STORAGE_KEYS = {
  theme: "derive_theme",
  cursorPref: "derive.cursor.pref",
  commentsPanel: "derive.comments.panel",
  navCollapsed: "derive.nav.collapsed",
  // Legacy literals (the colon convention predates the dot switch) — kept as-is so a
  // saved onboarding flag / folder pref survives the rename.
  onboarded: "derive:onboarded",
  libraryFolders: "derive:show-folders",
} as const
