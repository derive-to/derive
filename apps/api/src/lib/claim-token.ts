/**
 * Claim tokens for POST /v1/drafts/claim — the account-less publish → claim flow.
 *
 * An anonymous draft is published with no principal at all: nobody owns it, and
 * the only proof of "this is mine" is possession of the claim URL the publish
 * response handed back. This token IS that proof — a bearer capability binding
 * exactly one artifact, spendable by whichever signed-in user presents it first.
 * That is deliberate (capability, not identity, like publish/upload tokens): the
 * publisher had no identity to bind, and "whoever holds the link claims it"
 * matches how the draft itself is shared.
 *
 * Scoped tightly all the same:
 *   - bound to ONE artifact id; a leaked token can't touch anything else.
 *   - expiry rides the draft's own TTL, so the token dies with the draft.
 *   - single-use BY STATE, not by signature: the spend path re-checks that the
 *     artifact still lives in the drafts holding workspace and is unexpired. A
 *     claimed draft has moved out; a swept draft is gone — either way a replayed
 *     token finds nothing to spend. (HMAC tokens alone can't be single-use.)
 *
 * A thin wrapper over lib/capability-token.ts (which owns the HMAC format, key
 * caching, and edge-safety notes) with this kind's domain and its one-field
 * `<artifactId>` payload.
 */
import { signCapabilityToken, verifyCapabilityToken } from "./capability-token"

const DOMAIN = "derive-claim-token:"

/**
 * Sign a claim token.
 *
 * @param secret      The DERIVE_AUTH_SECRET / encryptionKey
 * @param artifactId  The draft artifact this token claims
 * @param expEpochMs  Expiry as ms since epoch — the draft's own expires_at, so
 *                    the token can never outlive the draft it claims
 */
export const signClaimToken = (
  secret: string,
  artifactId: string,
  expEpochMs: number,
): Promise<string> => signCapabilityToken(DOMAIN, secret, [artifactId], expEpochMs)

/**
 * Verify a claim token. Returns the artifact id, or null (bad signature,
 * malformed, expired). Never throws. The caller MUST still confirm the artifact
 * is an unexpired draft in the holding workspace — see the single-use note above.
 */
export const verifyClaimToken = async (
  secret: string,
  token: string,
  nowMs: number,
): Promise<{ artifactId: string } | null> => {
  const claim = await verifyCapabilityToken(DOMAIN, secret, token, nowMs)
  if (!claim?.rest) return null
  // Single-field payload: `rest` IS the artifact id.
  return { artifactId: claim.rest }
}
