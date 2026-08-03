/**
 * Short-lived tokens that authorize ONE artifact version's OG preview image on `/v1/og/:ref`.
 *
 * Why a token kind of its own, rather than reusing lib/preview-token.ts: that one grants read of
 * the artifact's RAW CONTENT (it exists so the screenshot renderer can load a private page), and
 * this URL travels much further — it is handed to Slack, fetched by Slack's image proxy, and
 * cached wherever that proxy caches. A token that leaked from an unfurl must not also unlock the
 * document. Same HMAC machinery, different domain, so one can never be replayed as the other.
 *
 * WHAT A HOLDER GETS, exactly: the 1200x630 rendered image of one artifact at one version
 * number — the first screen of the document, no more. Not the content, not later versions, not
 * a title or comment count (an expired or wrong token falls through to the anonymous locked
 * card, which reveals none of those).
 *
 * The version pin is the important half of that. A leaked URL goes stale on the next publish,
 * because the token names `n` and the endpoint only spends it on the CURRENT version. So the
 * blast radius of a leak is a snapshot of a document as it was, and it shrinks by itself.
 */
import { signCapabilityToken, verifyCapabilityToken } from "./capability-token"

const DOMAIN = "derive-og-token:"

/**
 * How long a minted OG token lives.
 *
 * Long, and that is deliberate. A Slack message keeps its unfurl for ever, and Slack's image
 * proxy re-fetches on its own schedule rather than rehosting once — so any expiry eventually
 * arrives while a message is still on screen. The endpoint is built so that this DEGRADES
 * (§ the fall-through in routes/embeds.ts): an expired token lands on the same anonymous locked
 * card the unfurl would have shown before any of this existed. Never a broken image, never an
 * error — just today's behaviour, later.
 *
 * That fallback is what makes a long life affordable rather than necessary, so this is set by
 * the other consideration: a quarter bounds what a leaked URL is worth, and the version pin
 * above usually settles it sooner.
 */
export const OG_TOKEN_TTL_MS = 90 * 24 * 60 * 60_000

/** Sign a token authorizing the OG image of exactly one artifact + version. */
export const signOgToken = (
  secret: string,
  artifactId: string,
  n: number,
  expEpochMs: number,
): Promise<string> => signCapabilityToken(DOMAIN, secret, [artifactId, String(n)], expEpochMs)

/** Verify one. Returns the artifact id + version, or null (bad signature, malformed, expired).
 *  Never throws — it runs on an unauthenticated path, where a throw is a 500 for a crawler. */
export const verifyOgToken = async (
  secret: string,
  token: string,
  nowMs: number,
): Promise<{ artifactId: string; n: number } | null> => {
  const claim = await verifyCapabilityToken(DOMAIN, secret, token, nowMs)
  if (!claim) return null
  // Payload: `<artifactId>.<n>` — split from the right, so an id containing dots still parses.
  const midDot = claim.rest.lastIndexOf(".")
  if (midDot <= 0) return null
  const n = Number(claim.rest.slice(midDot + 1))
  if (!Number.isInteger(n)) return null
  return { artifactId: claim.rest.slice(0, midDot), n }
}
