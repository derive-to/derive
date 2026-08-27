import type { AgentRecord } from "./ports"

/**
 * The request-level caller identity: WHO is making a request, resolved once per request.
 * Complements `Actor` (permissions.ts) — an `Actor` is the per-*artifact* authorization
 * input to `can()`, derived by narrowing a `Principal` against a specific artifact. The
 * Principal is the identity that precedes any artifact.
 *
 * The four historical resolvers (currentUser / agentFor / privateOwnerId / actingUser) plus
 * a loose on-behalf cache collapse into this one typed value. In particular **delegation is
 * explicit data**: an agent Principal carries the human it acts on behalf of (`onBehalfOf`)
 * rather than that relationship being re-inferred from a separate cache each time. This is
 * the seam a standards-based delegation chain (RFC 8693 `act`) slots into later.
 *
 *   · anonymous — no identity (a public-link visitor); never a trusted principal.
 *   · token     — the static DERIVE_TOKEN (instance automation / CI); acts as owner.
 *   · human     — a signed-in user, acting as themselves.
 *   · agent     — a registered or OAuth agent, acting on behalf of a human when known.
 */
export type Principal =
  | { kind: "anonymous" }
  | { kind: "token" }
  | { kind: "human"; user: PrincipalUser }
  | { kind: "agent"; agent: AgentRecord; onBehalfOf: string | null }

/** The identity-relevant projection of a signed-in user carried on a `human` Principal —
 *  enough to attribute authorship and key ownership, without the full profile. */
export interface PrincipalUser {
  id: string
  email: string
  name: string | null
  username: string | null
}

/**
 * The human id BEHIND a request: an agent's on-behalf human, or the human themselves; null
 * for anonymous or the static token. Keys `personal` comments and publish attribution +
 * ownership (an agent publishes as the user who registered/authorized it).
 */
export const principalOwnerId = (p: Principal): string | null =>
  p.kind === "agent" ? p.onBehalfOf : p.kind === "human" ? p.user.id : null

/**
 * The ACTING identity for authorship bylines: an agent authors as ITSELF (never spoofing a
 * person), a human as themselves. Null for anonymous or the static token (no authored byline).
 *
 * A person's byline is their DISPLAY NAME — `name`, else the handle, else the email — the one
 * rule every surface follows (a version's healed byline, `actingHuman`, `requireDirectHuman`,
 * lib/author.ts bylinesFrom). This used to prefer the handle, which is why one person read as
 * "Mert" on their versions and "mert-testing" on their comments, reactions, resolves, share
 * and follow notifications, Slack footers and the audit log. The handle rides along as
 * `handle` for the one legacy check that still matches by name (routes/comments.ts
 * ownsComment, for rows written before comments kept an author id).
 */
export const principalActor = (
  p: Principal,
): { id: string; name: string; handle: string | null } | null =>
  p.kind === "agent"
    ? { id: p.agent.id, name: p.agent.name, handle: null }
    : p.kind === "human"
      ? {
          id: p.user.id,
          name: p.user.name ?? p.user.username ?? p.user.email,
          handle: p.user.username ?? null,
        }
      : null

/** Is this an authenticated principal (token, agent, or human) rather than an anonymous
 *  visitor? The single "not anonymous" predicate behind the anon-write lockdown. */
export const isAuthenticated = (p: Principal): boolean => p.kind !== "anonymous"
