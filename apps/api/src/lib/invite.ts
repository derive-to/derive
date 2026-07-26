import type { Context } from "hono"
import { z } from "zod"
import { fail, readJson } from "./http"

/** Invite mechanics shared by the two invite flows (workspace → membership,
 *  artifact → artifact_member). The records differ; the token lifecycle — TTL,
 *  liveness, what's safe to echo, the email-mismatch contract — must not. */

/** How long an emailed invite link lives. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

/** Just enough of an email shape to be worth sending an invite to. */
export const looksLikeEmail = (s: string): boolean => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)

/** A pending invite is redeemable: not yet accepted, not past its TTL. */
export const isLiveInvite = (i: { accepted_at: string | null; expires_at: string }): boolean =>
  !i.accepted_at && new Date(i.expires_at).getTime() >= Date.now()

/** The invite fields safe to return — everything but the hashed token, which
 *  never leaves the server. Generic over the role so route response types keep
 *  the Role union rather than widening to string. */
export const inviteJson = <R extends string>(i: {
  id: string
  email: string
  role: R
  created_at: string
  expires_at: string
}) => ({
  id: i.id,
  email: i.email,
  role: i.role,
  created_at: i.created_at,
  expires_at: i.expires_at,
})

/**
 * The accept flow's identity check. Possession still authorizes (self-hosts
 * without email verification must keep working), but a signed-in account under a
 * different email is SURFACED, not silently joined: the holder must re-send with
 * `confirm_mismatch` to accept under this identity. The web accept pages pre-warn
 * from the preview and send the confirm with the click; the machine-readable 409
 * is for headless callers. Returns the 409 to bail with, or null to proceed.
 */
export const emailMismatch409 = async (
  c: Context,
  invitedEmail: string | null | undefined,
  currentEmail: string | null | undefined,
): Promise<Response | null> => {
  if (!invitedEmail || !currentEmail) return null
  if (invitedEmail.toLowerCase() === currentEmail.toLowerCase()) return null
  const b = await readJson(c, z.object({ confirm_mismatch: z.boolean().optional() }))
  // A malformed/absent body counts as "not confirmed", not a 400 — the 409
  // carries the flow either way.
  if (!(b instanceof Response) && b.confirm_mismatch === true) return null
  return fail(c, 409, "email_mismatch", { invited_email: invitedEmail })
}
