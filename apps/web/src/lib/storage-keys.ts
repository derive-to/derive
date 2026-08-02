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
  // One-shot (sessionStorage): the next boot drops the persisted query cache instead
  // of restoring it — set by reloadAfterWorkspaceChange (lib/persist) when the active
  // workspace changes, so another workspace's cache can't be rehydrated.
  cacheReset: "derive.cache.reset",
  // A stable, per-browser anonymous identity for realtime PRESENCE — generated once and
  // echoed on every realtime call, so one browser stays one "viewing now" row instead of
  // racing a server cookie into several phantom viewers (see lib/guest-id).
  guestId: "derive.guest",
  // Legacy literals (the colon convention predates the dot switch) — kept as-is so a
  // saved folder pref survives the rename. The onboarded value is the USER ID that
  // finished onboarding (needsOnboarding only honors a match), so a second account in
  // the same browser is still gated; old "1" values are deliberately not honored.
  onboarded: "derive:onboarded",
  libraryFolders: "derive:show-folders",
  // Grid or list, for the whole library. A PREFERENCE, not a per-route default: the
  // same document used to look like three different things depending on which door you
  // came through, and none of it was a choice anyone made.
  libraryLayout: "derive.library.layout",
  // Which collection groups are collapsed in the Collections list view. Per collection,
  // so opening a different workspace's shelves doesn't inherit this one's state.
  collectionGroups: "derive.collection.groups",
  // Dismissal of the home's one-time "set up your team's Brandprint" nudge (owners
  // of a Brandprint-less workspace; see pages/library/brandprint-nudge).
  brandprintNudge: "derive:brandprint-nudge",
  // Dismissal of the rail's getting-started checklist — one click, permanent,
  // per-browser (see chrome/getting-started).
  gettingStartedDismissed: "derive.getting-started.dismissed",
  // The checklist's "shared a link" step: set by the share dialog's copy-link
  // action (per-browser; the server signals cover connect + first publish).
  sharedLink: "derive.shared-link",
  // Dismissal of the home library's connect-your-agent card (see
  // pages/library/connect-nudge) — per-browser, one click, permanent.
  connectNudge: "derive.connect-nudge",
} as const
