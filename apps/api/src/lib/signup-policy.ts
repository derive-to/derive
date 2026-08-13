import type { MetaStore } from "@derive/core"
import type { Context } from "hono"
import { setCookie } from "hono/cookie"
import { signCapabilityToken, verifyCapabilityToken } from "./capability-token"

export type SignupMode = "open" | "invite" | "closed"
export type InviteKind = "workspace" | "artifact" | "collection"

export interface SignupAttempt {
  email: string
  cookieHeader: string | null
}

export const ADMISSION_COOKIE = "d_admission"
const ADMISSION_DOMAIN = "derive-signup-admission:"
const ADMISSION_TTL_MS = 15 * 60_000

export function parseSignupMode(value: string | undefined): SignupMode {
  const mode = value || "open"
  if (mode === "open" || mode === "invite" || mode === "closed") return mode
  throw new Error(`invalid DERIVE_SIGNUP_MODE: ${value} (expected open, invite, or closed)`)
}

const cookieFromHeader = (header: string | null, name: string): string | null => {
  if (!header) return null
  for (const part of header.split(";")) {
    const equals = part.indexOf("=")
    if (equals < 0 || part.slice(0, equals).trim() !== name) continue
    try {
      return decodeURIComponent(part.slice(equals + 1).trim())
    } catch {
      return null
    }
  }
  return null
}

/** Arm the auth endpoint with a short-lived, signed capability after a valid
 * invite preview. The raw invite token never enters a cookie or the auth hook. */
export async function armInviteAdmission(
  c: Context,
  kind: InviteKind,
  tokenHash: string,
  inviteExpiresAt: string,
  secret: string | undefined,
  cookie: { baseUrl: string; crossSite?: boolean },
): Promise<void> {
  if (!secret) return
  const now = Date.now()
  const minted = await mintInviteAdmission(kind, tokenHash, inviteExpiresAt, secret, now)
  if (!minted) return
  setCookie(c, ADMISSION_COOKIE, minted.token, {
    path: "/api/auth",
    httpOnly: true,
    // Match Better Auth's session-cookie policy. Without None+Secure here, an
    // invite can be previewed on a split web/API deployment but its capability
    // is silently withheld from the subsequent cross-site signup request.
    sameSite: cookie.crossSite ? "None" : "Lax",
    secure: cookie.crossSite || new URL(cookie.baseUrl).protocol === "https:",
    maxAge: Math.max(1, Math.floor((minted.expiresAt - now) / 1000)),
  })
}

/** Pure token mint used by the route wrapper above and focused policy tests. */
export async function mintInviteAdmission(
  kind: InviteKind,
  tokenHash: string,
  inviteExpiresAt: string,
  secret: string,
  now = Date.now(),
): Promise<{ token: string; expiresAt: number } | null> {
  const expiresAt = Math.min(Date.parse(inviteExpiresAt), now + ADMISSION_TTL_MS)
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return null
  return {
    token: await signCapabilityToken(ADMISSION_DOMAIN, secret, [kind, tokenHash], expiresAt),
    expiresAt,
  }
}

/** One provider-independent gate for Better Auth's user-create hook. In invite
 * mode the authority is possession of a live invitation capability, not
 * knowledge of the invitee's email. Closed mode is bootstrap-CLI only. */
export function signupPolicy(
  mode: SignupMode,
  secret: string,
  meta: Pick<MetaStore, "getInvitationByToken" | "getArtifactInviteByToken"> &
    Partial<Pick<MetaStore, "getCollectionInviteByToken">>,
): (attempt: SignupAttempt) => Promise<boolean> {
  return async ({ cookieHeader }) => {
    if (mode === "open") return true
    if (mode === "closed") return false
    const encoded = cookieFromHeader(cookieHeader, ADMISSION_COOKIE)
    if (!encoded) return false
    const verified = await verifyCapabilityToken(ADMISSION_DOMAIN, secret, encoded, Date.now())
    if (!verified) return false
    const [kind, tokenHash, extra] = verified.rest.split(".")
    if (extra !== undefined || !/^[0-9a-f]{64}$/.test(tokenHash ?? "")) return false
    const invite =
      kind === "workspace"
        ? await meta.getInvitationByToken(tokenHash ?? "")
        : kind === "artifact"
          ? await meta.getArtifactInviteByToken(tokenHash ?? "")
          : kind === "collection"
            ? await meta.getCollectionInviteByToken?.(tokenHash ?? "")
            : null
    return !!invite && invite.accepted_at === null && Date.parse(invite.expires_at) > Date.now()
  }
}
