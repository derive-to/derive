/**
 * A random client-side id, on every origin the app can actually be served from.
 *
 * `crypto.randomUUID` is SECURE-CONTEXT ONLY. On https and on localhost it exists; on
 * plain http to a hostname or a LAN IP it is `undefined`, and calling it throws. That is
 * not a hypothetical: it is how Derive gets reached when a self-host runs it over http on
 * an internal network, and when a phone is pointed at a laptop's dev server. Both are
 * ordinary, and in both the throw lands mid-handler, so the feature just stops with no
 * error to see.
 *
 * The randomness here is NOT security-bearing. These ids label optimistic rows and
 * anonymous presence, both of which the server re-derives or replaces; nothing trusts one.
 * So a Math.random fallback is the right shape, and using it never weakens anything.
 */
export const randomId = (): string =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`
