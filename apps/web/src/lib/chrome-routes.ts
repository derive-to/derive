// The routes that render without the app chrome (no nav rail): the auth /
// onboarding flows and the design canvas. One source of truth, read by AppFrame
// (post-hydration, to pick Outlet vs AppShell) AND inlined by __root's pre-paint
// boot script — so the static boot frame and the real frame agree on which entries
// get a rail. The boot script additionally treats a public artifact permalink
// (/artifacts/*) as "bare": AppShell renders it chrome-light until a session
// resolves, so a rail silhouette there would only flash away.
export const CHROMELESS_EXACT: string[] = [
  "/login",
  "/reset-password",
  "/welcome",
  "/showcase",
  "/roadmap",
]
export const CHROMELESS_PREFIX: string[] = ["/invite/"]

export const isChromelessPath = (p: string): boolean =>
  CHROMELESS_EXACT.includes(p) || CHROMELESS_PREFIX.some((prefix) => p.startsWith(prefix))
