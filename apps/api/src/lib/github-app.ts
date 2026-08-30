// GitHub App auth for the standard integration: sign App JWTs, mint tightly scoped
// installation tokens, and handle App setup/installer authorization. Everything runs on the
// Cloudflare Worker (node:crypto under nodejs_compat — same basis as ./crypto).

import { createPrivateKey, createSign } from "node:crypto"

const API = "https://api.github.com"
const WEB = "https://github.com"
const UA = "derive/1"
const API_VERSION = "2022-11-28"

const b64url = (b: Buffer | string): string => Buffer.from(b).toString("base64url")

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfter: string | null = null,
    readonly rateLimitRemaining: string | null = null,
    readonly rateLimitReset: string | null = null,
  ) {
    super(message)
    this.name = "GitHubError"
  }
}

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
  throw new GitHubError(
    res.status,
    `${what}: ${body.slice(0, 200) || res.statusText}`,
    res.headers.get("retry-after"),
    res.headers.get("x-ratelimit-remaining"),
    res.headers.get("x-ratelimit-reset"),
  )
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

export type GitHubTokenProfile =
  | "standard-read"
  | "pr-comment"
  | "workflow-read"
  | "workflow-dispatch"

const PROFILE_PERMISSIONS: Record<GitHubTokenProfile, Record<string, string>> = {
  "standard-read": { metadata: "read", pull_requests: "read" },
  "pr-comment": { metadata: "read", pull_requests: "write" },
  "workflow-read": { actions: "read", metadata: "read" },
  "workflow-dispatch": { actions: "write", metadata: "read" },
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
  owner: { login: string; type: string } | null
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
    owner?: { login?: string; type?: string } | null
    permissions?: Record<string, string>
    events?: string[]
  }
  return {
    slug: d.slug ?? "",
    html_url: d.html_url ?? "",
    owner: d.owner ? { login: d.owner.login ?? "", type: d.owner.type ?? "" } : null,
    permissions: d.permissions ?? {},
    events: d.events ?? [],
  }
}

// Per-isolate cache so a burst of source calls against one installation mints one token.
// Re-minted 60s before expiry. Cleared implicitly when the isolate recycles.
const tokenCache = new Map<string, InstallationToken>()
const TOKEN_CACHE_MAX = 500

const pruneTokenCache = (now: number): void => {
  for (const [key, value] of tokenCache)
    if (!Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= now)
      tokenCache.delete(key)
  while (tokenCache.size >= TOKEN_CACHE_MAX) {
    const oldest = tokenCache.keys().next().value
    if (typeof oldest !== "string") break
    tokenCache.delete(oldest)
  }
}

/** Mint (or reuse) an installation access token for `installationId`. */
export async function installationToken(
  appId: string,
  privateKeyPem: string,
  installationId: string,
  profile: GitHubTokenProfile = "standard-read",
  repository?: string,
): Promise<string> {
  if (!/^[1-9][0-9]{0,19}$/.test(installationId)) throw new Error("invalid GitHub installation id")
  if ((profile === "workflow-read" || profile === "workflow-dispatch") && !repository)
    throw new Error("a workflow token must name one repository")
  if (repository && !/^[A-Za-z0-9_.-]{1,100}$/.test(repository))
    throw new Error("invalid GitHub repository name")
  const cacheKey = `${appId}:${installationId}:${profile}:${repository ?? "*"}`
  const cached = tokenCache.get(cacheKey)
  if (cached && Date.parse(cached.expiresAt) - 60_000 > Date.now()) return cached.token

  const jwt = appJwt(appId, privateKeyPem)
  const res = await fetch(`${API}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: {
      ...ghHeaders(`Bearer ${jwt}`),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      permissions: PROFILE_PERMISSIONS[profile],
      ...(repository ? { repositories: [repository] } : {}),
    }),
  })
  if (!res.ok) return raise(res, "minting an installation token")
  const data = (await res.json()) as { token?: unknown; expires_at?: unknown }
  if (
    typeof data.token !== "string" ||
    !data.token ||
    data.token.length > 2_048 ||
    typeof data.expires_at !== "string" ||
    !Number.isFinite(Date.parse(data.expires_at))
  )
    throw new Error("GitHub returned an invalid installation token")
  pruneTokenCache(Date.now())
  tokenCache.set(cacheKey, { token: data.token, expiresAt: data.expires_at })
  return data.token
}

/** Read one installation with App-JWT auth. The callback uses this to label the standard
 *  source immediately, without listing every installation or asking the user to name it. */
export async function getAppInstallation(
  appId: string,
  privateKeyPem: string,
  installationId: string,
): Promise<AppInstallation> {
  const res = await fetch(`${API}/app/installations/${encodeURIComponent(installationId)}`, {
    headers: ghHeaders(`Bearer ${appJwt(appId, privateKeyPem)}`),
  })
  if (!res.ok) return raise(res, "reading the GitHub App installation")
  const data = (await res.json()) as {
    id?: number
    account?: { login?: string; type?: string }
    html_url?: string
    permissions?: Record<string, string>
  }
  return {
    id: data.id ?? Number(installationId),
    account: data.account
      ? { login: data.account.login ?? "", type: data.account.type ?? "" }
      : null,
    htmlUrl: data.html_url ?? null,
    permissions: data.permissions ?? {},
  }
}

/** Exchange GitHub's one-time web-flow code. The token exists only long enough to prove that
 * the signed-in installer can access the installation they are binding; it is never persisted. */
export async function exchangeGithubUserCode(input: {
  clientId: string
  clientSecret: string
  code: string
  redirectUri: string
  codeVerifier: string
}): Promise<string> {
  const res = await fetch(`${WEB}/login/oauth/access_token`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
    }),
  })
  if (!res.ok) return raise(res, "authorizing the GitHub installer")
  const data = (await res.json()) as { access_token?: string; error?: string }
  if (!data.access_token)
    throw new Error(`authorizing the GitHub installer failed (${data.error ?? "missing token"})`)
  return data.access_token
}

/** List installations this App's temporary user token can access. GitHub scopes this endpoint
 * to the App that issued the token, so it is safe to use for existing-install discovery. */
export async function listUserInstallations(userToken: string): Promise<AppInstallation[]> {
  const result: AppInstallation[] = []
  for (let page = 1; page <= 10; page++) {
    const res = await fetch(`${API}/user/installations?per_page=100&page=${page}`, {
      headers: ghHeaders(`Bearer ${userToken}`),
    })
    if (!res.ok) return raise(res, "checking the GitHub installer's installations")
    const data = (await res.json()) as {
      installations?: {
        id?: number
        account?: { login?: string; type?: string }
        html_url?: string
        permissions?: Record<string, string>
      }[]
    }
    const installations = data.installations ?? []
    for (const installation of installations) {
      if (!installation.id || !Number.isSafeInteger(installation.id)) continue
      result.push({
        id: installation.id,
        account: installation.account
          ? { login: installation.account.login ?? "", type: installation.account.type ?? "" }
          : null,
        htmlUrl: installation.html_url ?? null,
        permissions: installation.permissions ?? {},
      })
    }
    if (installations.length < 100) break
  }
  return result
}

/** GitHub's documented defense against a spoofed setup `installation_id`: use the temporary
 * user access token to confirm the installer is associated with that installation. */
export async function getUserInstallation(
  userToken: string,
  installationId: string,
): Promise<AppInstallation | null> {
  const installations = await listUserInstallations(userToken)
  return installations.find((installation) => String(installation.id) === installationId) ?? null
}

export interface AppInstallation {
  id: number
  account: { login: string; type: string } | null
  htmlUrl: string | null
  permissions: Record<string, string>
}

export interface ManifestConversion {
  app_id: string
  slug: string
  client_id: string
  client_secret: string
  /** PEM private key (PKCS#1). */
  pem: string
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
  }
  return {
    app_id: String(d.id),
    slug: d.slug,
    client_id: d.client_id,
    client_secret: d.client_secret,
    pem: d.pem,
  }
}
