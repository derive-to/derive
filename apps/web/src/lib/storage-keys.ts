// Every localStorage / sessionStorage key in one place, so a key can't be
// typo'd, duplicated, or drift out of the `dock` namespace. Enforced by
// scripts/check-frontend.mjs: storage may only be keyed by a member of this
// object, never a bare string literal.
export const STORAGE_KEYS = {
  theme: "dock_theme",
  libraryRail: "dock.browse.rail",
  commentsPanel: "dock.comments.panel",
  navCollapsed: "dock.nav.collapsed",
} as const
