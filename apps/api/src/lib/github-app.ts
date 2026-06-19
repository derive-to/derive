// GitHub App auth, layered on top of the read-only REST client in ./github.
// Three jobs: (1) sign the App-level JWT, (2) trade it for a short-lived
// installation token, (3) the manifest-conversion + webhook-signature helpers
// the one-click setup and push auto-sync need. Everything runs on Node and the
// Cloudflare Worker (node:crypto under nodejs_compat — same basis as ./crypto).

import { createHmac, createPrivateKey, createSign, timingSafeEqual } from "node:crypto"
import { GitHubError } from "./github"

const API = "https://api.github.com"
const UA = "dock-sync/1"
const API_VERSION = "2022-11-28"

const b64url = (b: Buffer | string): string => Buffer.from(b).toString("base64url")

// `auth` is omitted for the manifest-conversion call: that endpoint is
// unauthenticated (the one-time code is the credential), and sending a bogus
// Authorization header makes GitHub 401 with "Bad credentials".
const ghHeaders = (auth?: string): Record<string, string> => ({
  ...(auth ? { authorization: auth } : {}),
  accept: "application/vnd.github+json",
  "user-agent": UA,
  "x-github-api-version": API_VERSION,
})

const raise = async (res: Response, what: string): Promise<never> => {
  const body = await res.text().catch(() => "")
  throw new GitHubError(res.status, `${what}: ${body.slice(0, 200) || res.statusText}`)
}

/**
 * The App-level JWT (RS256). `iss` is the numeric App id; `iat` is backdated 60s
 * to tolerate clock skew and `exp` is +9min (GitHub caps it at 10). Signed with
 * `createSign` rather than jose so the App's PEM is accepted in BOTH the PKCS#1
 * ("BEGIN RSA PRIVATE KEY", what the manifest conversion returns) and PKCS#8
 * forms — `createPrivateKey` normalizes either, which jose's importPKCS8 won't.
 */
export function appJwt(
  appId: string,
  privateKeyPem: string,
  nowSec = Math.floor(Date.now() / 1000),
): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))
  const payload = b64url(JSON.stringify({ iat: nowSec - 60, exp: nowSec + 540, iss: appId }))
  const signingInput = `${header}.${payload}`
  const sig = createSign("RSA-SHA256")
    .update(signingInput)
    .end()
    .sign(createPrivateKey(privateKeyPem))
  return `${signingInput}.${b64url(sig)}`
}

export interface InstallationToken {
  token: string
  /** ISO expiry (GitHub installation tokens last ~1h). */
  expiresAt: string
}

/**
 * Fetch the App's own record (GET /app, App-JWT auth). Used to confirm a stored
 * App still exists on GitHub — if it was deleted, this 404s, and the caller treats
 * the stored credentials as stale so the UI can offer re-setup. Returns the live
 * slug (it can drift if the App was renamed) so callers can self-heal it.
 */
export async function getAppInfo(
  appId: string,
  privateKeyPem: string,
): Promise<{
  slug: string
  html_url: string
  permissions: Record<string, string>
  events: string[]
}> {
  const res = await fetch(`${API}/app`, {
    headers: ghHeaders(`Bearer ${appJwt(appId, privateKeyPem)}`),
  })
  if (!res.ok) return raise(res, "reading the GitHub App")
  const d = (await res.json()) as {
    slug?: string
    html_url?: string
    permissions?: Record<string, string>
    events?: string[]
  }
  return {
    slug: d.slug ?? "",
    html_url: d.html_url ?? "",
    permissions: d.permissions ?? {},
    events: d.events ?? [],
  }
}

// Per-isolate cache so a burst of syncs against one installation mints one token.
// Re-minted 60s before expiry. Cleared implicitly when the isolate recycles.
const tokenCache = new Map<string, InstallationToken>()

/** Mint (or reuse) an installation access token for `installationId`. */
export async function installationToken(
  appId: string,
  privateKeyPem: string,
  installationId: string,
): Promise<string> {
  const cached = tokenCache.get(installationId)
  if (cached && Date.parse(cached.expiresAt) - 60_000 > Date.now()) return cached.token

  const jwt = appJwt(appId, privateKeyPem)
  const res = await fetch(`${API}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: ghHeaders(`Bearer ${jwt}`),
  })
  if (!res.ok) return raise(res, "minting an installation token")
  const data = (await res.json()) as { token: string; expires_at: string }
  tokenCache.set(installationId, { token: data.token, expiresAt: data.expires_at })
  return data.token
}

export interface AppInstallation {
  id: number
  account: { login: string; type: string } | null
}

/** All installations of this App across GitHub accounts (App-JWT auth, paginated). */
export async function listAppInstallations(
  appId: string,
  privateKeyPem: string,
): Promise<AppInstallation[]> {
  const out: AppInstallation[] = []
  for (let page = 1; page <= 20; page++) {
    const res = await fetch(`${API}/app/installations?per_page=100&page=${page}`, {
      headers: ghHeaders(`Bearer ${appJwt(appId, privateKeyPem)}`),
    })
    if (!res.ok) return raise(res, "listing App installations")
    const data = (await res.json()) as {
      id?: number
      account?: { login?: string; type?: string }
    }[]
    if (!data.length) break
    out.push(
      ...data.map((i) => ({
        id: i.id ?? 0,
        account: i.account ? { login: i.account.login ?? "", type: i.account.type ?? "" } : null,
      })),
    )
    if (data.length < 100) break
  }
  return out
}

export interface InstallationRepo {
  full_name: string
  private: boolean
  default_branch: string
  /** Last push (ISO); drives the picker's most-recent-first ordering. */
  pushed_at: string | null
}

/** Every repo the installation can read (paginated, capped at 1000), sorted
 *  most-recently-pushed first so the picker surfaces active repos at the top. */
export async function listInstallationRepos(token: string): Promise<InstallationRepo[]> {
  const out: InstallationRepo[] = []
  for (let page = 1; page <= 10; page++) {
    const res = await fetch(`${API}/installation/repositories?per_page=100&page=${page}`, {
      headers: ghHeaders(`Bearer ${token}`),
    })
    if (!res.ok) return raise(res, "listing installation repositories")
    const data = (await res.json()) as {
      repositories?: (InstallationRepo & { pushed_at?: string | null })[]
    }
    const repos = data.repositories ?? []
    out.push(
      ...repos.map((r) => ({
        full_name: r.full_name,
        private: r.private,
        default_branch: r.default_branch,
        pushed_at: r.pushed_at ?? null,
      })),
    )
    if (repos.length < 100) break
  }
  // Most-recently-pushed first; repos without a timestamp sink to the bottom.
  return out.sort((a, b) => (b.pushed_at ?? "").localeCompare(a.pushed_at ?? ""))
}

export interface ManifestConversion {
  app_id: string
  slug: string
  client_id: string
  client_secret: string
  /** PEM private key (PKCS#1). */
  pem: string
  webhook_secret: string
}

/**
 * Trade the temporary code GitHub returns from the App-manifest flow for the new
 * App's permanent credentials. One-time and short-lived, so it's called once at
 * the end of "Set up GitHub App".
 */
export async function convertManifestCode(code: string): Promise<ManifestConversion> {
  const res = await fetch(`${API}/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: "POST",
    headers: ghHeaders(),
  })
  if (!res.ok) return raise(res, "creating the GitHub App")
  const d = (await res.json()) as {
    id: number
    slug: string
    client_id: string
    client_secret: string
    pem: string
    webhook_secret: string
  }
  return {
    app_id: String(d.id),
    slug: d.slug,
    client_id: d.client_id,
    client_secret: d.client_secret,
    pem: d.pem,
    webhook_secret: d.webhook_secret,
  }
}

/**
 * Verify a webhook's `x-hub-signature-256` header (HMAC-SHA256 of the raw body
 * keyed by the App's webhook secret). Constant-time, and length-guarded so the
 * compare never throws on a malformed header.
 */
export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader) return false
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`
  const a = Buffer.from(expected)
  const b = Buffer.from(signatureHeader)
  return a.length === b.length && timingSafeEqual(a, b)
}
