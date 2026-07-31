/**
 * OAuth credentials for MCP sources: what is stored, and how a live access token is produced.
 *
 * WHY THIS EXISTS. Connecting a real MCP server means pasting a long-lived API key today —
 * Stripe's own docs call that the fallback "if your MCP client doesn't support OAuth". A pasted
 * key is scoped by hand, rotated by nobody, and is the first thing a new user is asked to do with
 * their billing account. OAuth replaces it with one sign-in.
 *
 * WHAT IS STORED. Everything rides in the EXISTING `secret_enc` column, encrypted as one JSON
 * blob, so this needs no migration and no new columns:
 *
 *     { v: 1, access_token, refresh_token?, expires_at?, token_endpoint, client_id, ... }
 *
 * A pasted key stays exactly what it was — a bare string — and `readCredential` tells the two
 * apart by shape. That is deliberate: the two kinds have to coexist forever, because plenty of
 * MCP servers offer no OAuth at all.
 *
 * THE PROTOCOL IS NOT OURS. Discovery, registration, PKCE, the code exchange and the refresh all
 * come from `@modelcontextprotocol/sdk`, which is MIT, already a dependency of this app, and
 * verified to run in workerd against Stripe's live authorization server. What is ours is the part
 * no library can do: deciding where the token lives and when it is stale.
 */

import type { ConnectionRecord, MetaStore } from "@derive/core"
import { refreshAuthorization } from "@modelcontextprotocol/sdk/client/auth.js"
import { decryptSecret, encryptSecret } from "./crypto"

/** Refresh this long before the access token actually expires, so a token cannot go stale
 *  between the check and the call it is about to authorize. */
const REFRESH_SKEW_MS = 60_000

export interface McpOauthCredential {
  v: 1
  access_token: string
  refresh_token?: string
  /** Epoch ms. Absent means the server issued no expiry, so the token is used until it 401s. */
  expires_at?: number
  /** Where to refresh. Stored because rediscovering it on every refresh is a wasted round trip
   *  and a second chance for discovery to fail at exactly the wrong moment. */
  token_endpoint: string
  authorization_server: string
  client_id: string
  client_secret?: string
  /** RFC 8707: the resource this token is bound to. */
  resource?: string
}

/**
 * A dynamic client registration, kept so a second sign-in reuses the first one's client.
 *
 * Registration is not idempotent: Linear hands back a NEW client_id for byte-identical metadata
 * every time it is asked. Registering per attempt would leave one abandoned OAuth client at the
 * provider for every Sign in click, every retry and every flow someone thought better of — on an
 * endpoint that is a standing rate-limit and abuse target.
 *
 * It lives in the same encrypted blob as the credential, so it costs no column, and it is written
 * BEFORE consent — which is the whole point, since a flow that never completes is exactly the case
 * that would otherwise re-register.
 */
export interface McpOauthClient {
  v: 1
  kind: "client"
  client_id: string
  client_secret?: string
  /** Which authorization server issued it. A server that moves invalidates the reuse. */
  authorization_server: string
}

export type StoredCredential =
  | { kind: "oauth"; cred: McpOauthCredential }
  | { kind: "client"; client: McpOauthClient }
  | { kind: "bearer"; token: string }
  | { kind: "unreadable" }

export const serializeCredential = (cred: McpOauthCredential, key: string): string =>
  encryptSecret(JSON.stringify(cred), key)

export const serializeClient = (client: McpOauthClient, key: string): string =>
  encryptSecret(JSON.stringify(client), key)

/**
 * Read a stored credential without ever handing back something unusable.
 *
 * `decryptSecret` FAILS SOFT by design — it returns its input unchanged when the blob has no
 * `v1.` prefix (a value stored before encryption was configured) and again when the key is wrong
 * or the ciphertext is corrupt. That is right for a first-party API where a bad token merely
 * 401s. It is wrong here: an MCP bearer goes to somebody ELSE'S server, so returning the blob
 * would send our IV, auth tag and ciphertext to a third party, silently, on every run.
 *
 * So a value that still looks like an envelope after decryption is treated as UNREADABLE and
 * nothing is sent. The caller reports it as a fault on our side rather than blaming the server.
 */
export const readCredential = (
  secretEnc: string | null,
  key: string | undefined,
): StoredCredential => {
  if (!secretEnc) return { kind: "unreadable" }
  if (!key) return { kind: "unreadable" }
  const plain = decryptSecret(secretEnc, key)
  // Still an envelope ⇒ decryptSecret handed the input straight back: wrong key, or corrupt.
  if (plain.startsWith("v1.")) return { kind: "unreadable" }
  if (!plain.startsWith("{")) return { kind: "bearer", token: plain }
  try {
    const parsed = JSON.parse(plain) as McpOauthCredential & McpOauthClient
    if (parsed?.v === 1 && typeof parsed.access_token === "string")
      return { kind: "oauth", cred: parsed }
    // A registration with no tokens yet. NOT a bearer: there is nothing here to send, and
    // falling through would put a JSON blob in an Authorization header.
    if (parsed?.v === 1 && parsed.kind === "client" && typeof parsed.client_id === "string")
      return { kind: "client", client: parsed }
  } catch {
    // A JSON-shaped bearer token is vanishingly unlikely, but falling through to "use it as a
    // bearer" is the safe reading: it is at worst a token the server rejects.
  }
  return { kind: "bearer", token: plain }
}

const expired = (cred: McpOauthCredential): boolean =>
  typeof cred.expires_at === "number" && cred.expires_at - REFRESH_SKEW_MS <= Date.now()

/**
 * The live bearer for one connection: the stored token, refreshed first if it is about to expire.
 *
 * Returns undefined when there is nothing usable to send — an unreadable blob, or a refresh that
 * failed — because sending nothing produces an honest 401 from the server, while sending garbage
 * produces a confusing one and leaks whatever the garbage was.
 */
export const liveBearer = async (
  meta: MetaStore,
  cn: ConnectionRecord,
  key: string | undefined,
): Promise<string | undefined> => {
  const stored = readCredential(cn.secret_enc, key)
  if (stored.kind === "unreadable") return undefined
  // Registered but never authorized: there is no token to send, and sending nothing produces an
  // honest 401 rather than a confusing one.
  if (stored.kind === "client") return undefined
  if (stored.kind === "bearer") return stored.token
  const { cred } = stored
  if (!expired(cred) || !cred.refresh_token || !key) return cred.access_token

  try {
    const tokens = await refreshAuthorization(cred.authorization_server, {
      metadata: { token_endpoint: cred.token_endpoint } as never,
      clientInformation: { client_id: cred.client_id, client_secret: cred.client_secret },
      refreshToken: cred.refresh_token,
      ...(cred.resource ? { resource: new URL(cred.resource) } : {}),
    })
    const next: McpOauthCredential = {
      ...cred,
      access_token: tokens.access_token,
      // A server that rotates the refresh token returns a new one; one that does not keeps ours.
      refresh_token: tokens.refresh_token ?? cred.refresh_token,
      ...(tokens.expires_in ? { expires_at: Date.now() + tokens.expires_in * 1000 } : {}),
    }
    // COMPARE-AND-SWAP against the blob we read. Two runs can hit an expired token in the same
    // second and both refresh; without this the slower reply overwrites the newer token with an
    // older one and invalidates a grant that was working. Losing the swap is not an error — the
    // winner's token is live, and it is the one we return.
    const saved = await meta.updateConnectionCredential(
      cn.id,
      cn.org_id,
      { secret_enc: serializeCredential(next, key) },
      cn.secret_enc,
    )
    if (saved) return next.access_token
    const fresh = await meta.getConnection(cn.id)
    const reread = fresh ? readCredential(fresh.secret_enc, key) : { kind: "unreadable" as const }
    return reread.kind === "oauth" ? reread.cred.access_token : undefined
  } catch {
    // A refresh that fails is a dead grant (revoked, expired beyond refresh, or the server is
    // down). Send nothing: the run then fails closed naming the source, which is the outcome a
    // person can act on.
    return undefined
  }
}
