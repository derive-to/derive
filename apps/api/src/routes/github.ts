import { createHash, createHmac } from "node:crypto"
import type { GitHubAppRecord } from "@derive/core"
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { BlankEnv } from "hono/types"
import type { AppContext } from "../context"
import { ACTIONS_PERMISSION, REQUIRED_PERMISSIONS } from "../github-app-setup"
import { decryptSecret, signState, verifyState } from "../lib/crypto"
import {
  exchangeGithubUserCode,
  GitHubError,
  getAppInfo,
  getAppInstallation,
  getUserInstallation,
} from "../lib/github-app"
import { upsertGithubConnection } from "../lib/github-connection"
import { bail, fail } from "../lib/http"
import { log } from "../log"

interface InstallState {
  kind: "github-install-setup"
  org: string
  uid: string
  iat: number
}

interface AuthorizationState {
  kind: "github-install-authorize"
  org: string
  uid: string
  installationId: string
  iat: number
}

const installationIdIsValid = (value: string | undefined): value is string =>
  !!value && /^[1-9][0-9]*$/.test(value)

export const githubRoutes = (ctx: AppContext) => {
  const { meta, deps, requireUser, requireWorkspace, workspaceCan, activeWorkspace, currentUser } =
    ctx
  const app = new OpenAPIHono<BlankEnv>()

  const loadApp = async (): Promise<{ app: GitHubAppRecord; pem: string } | null> => {
    if (!deps.encryptionKey) return null
    const found = await meta.getGithubApp()
    if (!found) return null
    return { app: found, pem: decryptSecret(found.private_key, deps.encryptionKey) }
  }

  const settingsRedirect = (
    result: "connected" | "canceled" | "expired" | "config" | "save",
  ): string =>
    result === "connected"
      ? "/settings/integrations?github_connected=1"
      : `/settings/integrations?github_error=${result}`

  const loginRedirect = (url: string): string => {
    const here = new URL(url)
    return `/login?return_to=${encodeURIComponent(`${here.pathname}${here.search}`)}`
  }

  const codeVerifier = (state: string, key: string): string =>
    createHmac("sha256", `derive-github-pkce:${key}`).update(state).digest("base64url")

  const codeChallenge = (verifier: string): string =>
    createHash("sha256").update(verifier).digest("base64url")

  const Account = z.object({
    installation_id: z.string(),
    account_login: z.string().nullable(),
    connection_id: z.string().nullable(),
    state: z.enum(["active", "disconnected", "needs_reauth"]),
  })
  const GithubStatus = z
    .object({
      available: z.boolean().describe("Whether this instance has a live GitHub App configured"),
      connected: z
        .boolean()
        .describe("Whether this workspace has at least one active GitHub connection"),
      app_slug: z.string().nullable(),
      needs_permissions: z.boolean(),
      actions_available: z
        .boolean()
        .nullable()
        .describe(
          "Whether the configured App and its connected installations can dispatch GitHub Actions workflows; null when GitHub could not be checked",
        ),
      permissions_url: z.string().nullable(),
      accounts: z.array(Account),
    })
    .openapi("GithubStatus")

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/github",
      tags: ["GitHub"],
      summary: "GitHub standard-integration status for the current workspace.",
      responses: {
        200: {
          description: "App availability, connection health, and connected GitHub accounts.",
          content: { "application/json": { schema: GithubStatus } },
        },
      },
    }),
    async (c) => {
      const me = await requireUser(c)
      if (me instanceof Response) return bail(me)
      const org = await requireWorkspace(c, "read")
      if (org instanceof Response) return bail(org)
      const [loaded, installs, connections] = await Promise.all([
        loadApp(),
        meta.listGithubInstallations(org),
        meta.listConnections(org, undefined, "workspace"),
      ])

      let available = !!loaded
      let slug = loaded?.app.slug ?? null
      let needsPermissions = false
      // Null means GitHub could not be checked. Do not turn a transient outage into a false
      // permission-upgrade prompt.
      let appActionsAvailable: boolean | null = null
      const rank: Record<string, number> = { read: 1, write: 2, admin: 3 }
      if (loaded) {
        try {
          const live = await getAppInfo(loaded.app.app_id, loaded.pem)
          slug = live.slug || slug
          if (slug && slug !== loaded.app.slug) await meta.setGithubApp({ ...loaded.app, slug })
          needsPermissions = Object.entries(REQUIRED_PERMISSIONS).some(
            ([permission, level]) =>
              !live.permissions[permission] ||
              (rank[live.permissions[permission] ?? ""] ?? 0) < (rank[level] ?? 0),
          )
          appActionsAvailable = Object.entries(ACTIONS_PERMISSION).every(
            ([permission, level]) =>
              !!live.permissions[permission] &&
              (rank[live.permissions[permission] ?? ""] ?? 0) >= (rank[level] ?? 0),
          )
        } catch (err) {
          // Deleted/revoked is definitive. A network/5xx failure must not hide a working App.
          if (err instanceof GitHubError && (err.status === 401 || err.status === 404))
            available = false
        }
      }

      const githubConnections = connections.filter((cn) => cn.kind === "github_app")
      const byInstallation = new Map(githubConnections.map((cn) => [cn.broker_ref, cn]))
      const installIds = new Set(installs.map((installation) => installation.installation_id))
      // A stored row is not proof the installation still exists. Check each account live so
      // Settings can distinguish a working connection from an App GitHub has removed. Treat
      // only definitive auth/not-found responses as stale; a transient GitHub outage must not
      // make healthy connections disappear.
      const staleInstallations = new Set<string>()
      const installationActions = new Map<string, boolean>()
      let installationPermissionsUrl: string | null = null
      if (loaded && available) {
        await Promise.all(
          installs.map(async (installation) => {
            try {
              const live = await getAppInstallation(
                loaded.app.app_id,
                loaded.pem,
                installation.installation_id,
              )
              const actions = Object.entries(ACTIONS_PERMISSION).every(
                ([permission, level]) =>
                  !!live.permissions[permission] &&
                  (rank[live.permissions[permission] ?? ""] ?? 0) >= (rank[level] ?? 0),
              )
              installationActions.set(installation.installation_id, actions)
              if (!actions && !installationPermissionsUrl && live.htmlUrl)
                installationPermissionsUrl = live.htmlUrl
            } catch (err) {
              if (
                err instanceof GitHubError &&
                (err.status === 401 || err.status === 403 || err.status === 404)
              )
                staleInstallations.add(installation.installation_id)
            }
          }),
        )
      }
      const liveInstallationIds = installs
        .map((installation) => installation.installation_id)
        .filter((id) => !staleInstallations.has(id))
      let actionsAvailable = appActionsAvailable
      if (appActionsAvailable === true && liveInstallationIds.length > 0) {
        if (liveInstallationIds.some((id) => installationActions.get(id) === false))
          actionsAvailable = false
        else if (liveInstallationIds.some((id) => !installationActions.has(id)))
          actionsAvailable = null
      }
      const accounts: {
        installation_id: string
        account_login: string | null
        connection_id: string | null
        state: "active" | "disconnected" | "needs_reauth"
      }[] = installs.map((installation) => {
        const connection = byInstallation.get(installation.installation_id)
        const usable =
          connection?.status === "active" &&
          available &&
          !needsPermissions &&
          !staleInstallations.has(installation.installation_id)
        return {
          installation_id: installation.installation_id,
          account_login: installation.account_login ?? connection?.scopes_label ?? null,
          connection_id: connection?.id ?? null,
          state: usable
            ? ("active" as const)
            : connection?.status === "active"
              ? ("needs_reauth" as const)
              : ("disconnected" as const),
        }
      })
      for (const connection of githubConnections) {
        if (installIds.has(connection.broker_ref)) continue
        accounts.push({
          installation_id: connection.broker_ref,
          account_login: connection.scopes_label,
          connection_id: connection.id,
          state: "needs_reauth",
        })
      }

      return c.json({
        available,
        connected: accounts.some((account) => account.state === "active"),
        app_slug: slug,
        needs_permissions: needsPermissions,
        actions_available: actionsAvailable,
        permissions_url:
          appActionsAvailable === true && installationPermissionsUrl
            ? installationPermissionsUrl
            : slug
              ? `https://github.com/settings/apps/${encodeURIComponent(slug)}/permissions`
              : null,
        accounts,
      })
    },
  )

  // One navigation, like Slack: admin → GitHub login/SSO/repository selection → callback.
  app.get("/v1/github/install", async (c) => {
    const org = await requireWorkspace(c, "manage")
    if (org instanceof Response) return org
    const me = await requireUser(c)
    if (me instanceof Response) return me
    const loaded = await loadApp()
    if (!loaded || !deps.encryptionKey) return fail(c, 404, "GitHub is not configured")
    const state = signState({ kind: "github-install-setup", org, uid: me.id }, deps.encryptionKey)
    return c.redirect(
      `https://github.com/apps/${encodeURIComponent(loaded.app.slug)}/installations/new?state=${encodeURIComponent(state)}`,
    )
  })

  // GitHub warns that installation_id on a setup callback is attacker-controlled. This first
  // callback therefore verifies the App + Derive manager, then starts GitHub's user OAuth proof.
  // Nothing is persisted until /authorize confirms this user can access this installation.
  app.get("/v1/github/callback", async (c) => {
    const installationId = c.req.query("installation_id")
    const stateRaw = c.req.query("state") ?? ""
    if (c.req.query("setup_action") === "request") return c.redirect(settingsRedirect("canceled"))
    if (!deps.encryptionKey || !installationIdIsValid(installationId))
      return c.redirect(settingsRedirect("config"))

    const state = verifyState<InstallState>(stateRaw, deps.encryptionKey)
    if (stateRaw && state?.kind !== "github-install-setup")
      return c.redirect(settingsRedirect("expired"))

    const me = await currentUser(c)
    if (!me) return c.redirect(loginRedirect(c.req.url))

    let org = state?.org ?? null
    let uid = state?.uid ?? null
    if (!state) {
      // A direct install carries no signed state. It may bind only to the active workspace of
      // a currently signed-in manager; an ordinary member cannot smuggle in infrastructure.
      if (!(await workspaceCan(c, "manage"))) return c.redirect(settingsRedirect("expired"))
      org = await activeWorkspace(c)
      uid = me.id
    }
    if (
      !org ||
      !uid ||
      uid !== me.id ||
      org !== (await activeWorkspace(c)) ||
      !(await workspaceCan(c, "manage"))
    )
      return c.redirect(settingsRedirect("expired"))

    const loaded = await loadApp()
    if (!loaded) return c.redirect(settingsRedirect("config"))
    try {
      await getAppInstallation(loaded.app.app_id, loaded.pem, installationId)
    } catch (err) {
      // This lookup is also proof the id belongs to THIS App. Never persist an unverified id
      // from a hand-edited callback; it would create a source that can never mint a token.
      log.warn("github installation verification failed", {
        installation_id: installationId,
        error: err instanceof Error ? err.message : String(err),
      })
      return c.redirect(settingsRedirect("save"))
    }

    const authorizationState = signState(
      { kind: "github-install-authorize", org, uid, installationId },
      deps.encryptionKey,
    )
    const verifier = codeVerifier(authorizationState, deps.encryptionKey)
    const redirectUri = new URL("/v1/github/authorize", deps.baseUrl).toString()
    const authorize = new URL("https://github.com/login/oauth/authorize")
    authorize.searchParams.set("client_id", loaded.app.client_id)
    authorize.searchParams.set("redirect_uri", redirectUri)
    authorize.searchParams.set("state", authorizationState)
    authorize.searchParams.set("code_challenge", codeChallenge(verifier))
    authorize.searchParams.set("code_challenge_method", "S256")
    authorize.searchParams.set("prompt", "select_account")
    return c.redirect(authorize.toString())
  })

  app.get("/v1/github/authorize", async (c) => {
    const code = c.req.query("code")
    const stateRaw = c.req.query("state") ?? ""
    if (c.req.query("error") === "access_denied") return c.redirect(settingsRedirect("canceled"))
    if (!deps.encryptionKey || !code) return c.redirect(settingsRedirect("config"))
    const state = verifyState<AuthorizationState>(stateRaw, deps.encryptionKey)
    if (state?.kind !== "github-install-authorize" || !installationIdIsValid(state.installationId))
      return c.redirect(settingsRedirect("expired"))

    const me = await currentUser(c)
    if (!me) return c.redirect(loginRedirect(c.req.url))
    if (
      me.id !== state.uid ||
      state.org !== (await activeWorkspace(c)) ||
      !(await workspaceCan(c, "manage"))
    )
      return c.redirect(settingsRedirect("expired"))

    const loaded = await loadApp()
    if (!loaded) return c.redirect(settingsRedirect("config"))
    try {
      const userToken = await exchangeGithubUserCode({
        clientId: loaded.app.client_id,
        clientSecret: decryptSecret(loaded.app.client_secret, deps.encryptionKey),
        code,
        redirectUri: new URL("/v1/github/authorize", deps.baseUrl).toString(),
        codeVerifier: codeVerifier(stateRaw, deps.encryptionKey),
      })
      const installation = await getUserInstallation(userToken, state.installationId)
      if (!installation) {
        log.warn("github installer cannot access installation", {
          installation_id: state.installationId,
          user_id: me.id,
        })
        return c.redirect(settingsRedirect("save"))
      }
      const accountLogin = installation.account?.login ?? null
      await meta.upsertGithubInstallation({
        installation_id: state.installationId,
        org_id: state.org,
        account_login: accountLogin,
        created_by: me.id,
        created_at: new Date().toISOString(),
      })
      await upsertGithubConnection(meta, {
        orgId: state.org,
        userId: me.id,
        installationId: state.installationId,
        accountLogin,
      })
      return c.redirect(settingsRedirect("connected"))
    } catch (err) {
      log.warn("github integration save failed", {
        installation_id: state.installationId,
        error: err instanceof Error ? err.message : String(err),
      })
      return c.redirect(settingsRedirect("save"))
    }
  })

  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/github/connections/{id}",
      tags: ["GitHub"],
      summary: "Disconnect one GitHub installation from agent use (Admin only).",
      request: { params: z.object({ id: z.string() }) },
      responses: { 204: { description: "The GitHub connection was disconnected." } },
    }),
    async (c) => {
      const org = await requireWorkspace(c, "manage")
      if (org instanceof Response) return bail(org)
      const connection = await meta.getConnection(c.req.param("id"))
      if (!connection || connection.org_id !== org || connection.kind !== "github_app")
        return bail(fail(c, 404, "GitHub connection not found"))
      await meta.setConnectionStatus(connection.id, org, "revoked")
      return c.body(null, 204)
    },
  )

  return app
}
