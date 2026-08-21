/**
 * In-band step-up: turn "forbidden" into a next step.
 *
 * A scope refusal used to be a dead end. The agent learns it can't do the thing, but
 * not WHY — and the two whys need opposite fixes: a SCOPE gap is repaired by the human
 * re-consenting the connection with a wider scope, a ROLE gap by an admin changing
 * their membership. Guessing wrong wastes a round trip at best; at worst the agent goes
 * looking for a second credential, which is the detour that makes auth hurt.
 *
 * So every refusal that can name the lever should. This computes which lever it is by
 * comparing the grant's own scope ceiling against the human's membership role: if the
 * scope is what's short, say so and point at where to re-consent; if the seat is what's
 * short, say that instead, because no amount of re-consenting will fix it.
 */
import { type Action, capRole, type Role, roleAllows } from "@derive/core"

/** The scope a caller would need consented to reach each action. */
const SCOPE_FOR_ACTION: Partial<Record<Action, string>> = {
  comment: "derive:comment",
  publish: "derive:publish",
  share: "derive:publish",
  manage: "derive:manage",
}

export interface ScopeGapInput {
  /** What the caller tried to do. */
  action: Action
  /** The grant's UNCAPPED scope-derived role (a registered token's runtime role). */
  scopeRole: Role
  /** The human's live membership role in the workspace (null = not a member). */
  memberRole: Role | null
  /** This connection is a registered dk_agt_ token, not a human's OAuth grant —
   *  re-consent is not a thing it can do, so never suggest it. */
  registered: boolean
  /** Server base URL, for the settings link. */
  baseUrl: string
}

/**
 * A refusal sentence that names the lever, or null when the action is actually
 * allowed (callers gate on their own check first; this only explains failures).
 */
export const scopeGapMessage = ({
  action,
  scopeRole,
  memberRole,
  registered,
  baseUrl,
}: ScopeGapInput): string | null => {
  const effective = capRole(scopeRole, memberRole ?? "viewer")
  if (memberRole && roleAllows(effective, action)) return null
  const settings = `${baseUrl.replace(/\/$/, "")}/settings/agents`
  if (!memberRole)
    return `You aren't a member of that workspace, so nothing there is reachable. An admin has to add you.`

  const scopeShort = !roleAllows(scopeRole, action)
  const seatShort = !roleAllows(memberRole, action)
  const needed = SCOPE_FOR_ACTION[action]

  // Both short: fixing only one changes nothing, so say both, seat first (an admin's
  // action gates the human's, and re-consenting to a scope above your seat is wasted).
  if (scopeShort && seatShort)
    return (
      `Can't ${action} here: this connection holds ${scopeRole} access and your membership is ${memberRole} — both are below what's needed. ` +
      `Ask an admin to raise your role, then reconnect with the ${needed ?? "required"} scope at ${settings}.`
    )
  if (seatShort)
    return `Can't ${action} here: your membership in this workspace is ${memberRole}. Re-consenting won't change that — an admin has to raise your role.`
  if (scopeShort)
    return registered
      ? `Can't ${action} here: this agent token's role is ${scopeRole}. An admin can rotate it at a higher role (${settings}).`
      : `Can't ${action} here: this connection was consented with ${scopeRole} access only (your membership would allow it). Reconnect with the ${needed ?? "required"} scope at ${settings} to grant it.`
  return null
}
