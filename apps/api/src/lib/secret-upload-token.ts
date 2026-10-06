/**
 * Short-lived tokens for POST /v1/secrets/t/:token, minted by the MCP `stage` tool
 * (target:'secret'). A coding session can call tools but should never see a secret's value:
 * typed into a tool call, the value would sit in the transcript. So the session mints this
 * URL and its shell spends it with `curl --data-binary @file`; the value goes from the file
 * to Derive without passing through the model.
 *
 * Grants one thing until expiry: saving a personal secret for the minting user, optionally
 * bound to one variable on one agent. Like the other upload tokens it is spendable more than
 * once within its lifetime, and the spend re-checks the user's live seat and, when an agent
 * is named, that they still manage it.
 *
 * Built on lib/capability-token.ts. The claim rides as one JSON field; the format splits
 * only the final dot (the expiry), so dots inside the JSON are safe.
 */
import { signCapabilityToken, verifyCapabilityToken } from "./capability-token"

const DOMAIN = "derive-secret-upload:"

/** Long enough to run one curl, short enough that a URL left in a transcript soon lapses. */
export const SECRET_UPLOAD_TTL_MS = 10 * 60 * 1000

export interface SecretUploadClaim {
  orgId: string
  userId: string
  /** The secret's display name. */
  name: string
  /** Bind the saved secret to this agent's environment under `variable`. */
  agentId: string | null
  variable: string | null
}

export const signSecretUploadToken = (
  secret: string,
  claim: SecretUploadClaim,
  expEpochMs: number,
): Promise<string> => signCapabilityToken(DOMAIN, secret, [JSON.stringify(claim)], expEpochMs)

/** The claim, or null for a bad signature, a malformed payload, or an expired token. */
export const verifySecretUploadToken = async (
  secret: string,
  token: string,
  nowMs: number,
): Promise<SecretUploadClaim | null> => {
  const verified = await verifyCapabilityToken(DOMAIN, secret, token, nowMs)
  if (!verified) return null
  try {
    const c = JSON.parse(verified.rest) as Partial<SecretUploadClaim>
    if (typeof c.orgId !== "string" || typeof c.userId !== "string" || typeof c.name !== "string")
      return null
    return {
      orgId: c.orgId,
      userId: c.userId,
      name: c.name,
      agentId: typeof c.agentId === "string" ? c.agentId : null,
      variable: typeof c.variable === "string" ? c.variable : null,
    }
  } catch {
    return null
  }
}
