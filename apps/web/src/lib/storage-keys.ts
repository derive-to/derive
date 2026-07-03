// Every localStorage / sessionStorage key in one place, so a key can't be
// typo'd, duplicated, or drift out of the `derive` namespace. Enforced by
// scripts/check-frontend.mjs: storage may only be keyed by a member of this
// object, never a bare string literal.
export const STORAGE_KEYS = {
  theme: "derive_theme",
  cursorPref: "derive.cursor.pref",
  libraryRail: "derive.browse.rail",
  commentsPanel: "derive.comments.panel",
  navCollapsed: "derive.nav.collapsed",
  // Legacy literal (predates the dot convention) — kept so saved prefs survive.
  libraryFolders: "derive:show-folders",
} as const
