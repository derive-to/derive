import { createHash, createHmac } from "node:crypto"
import type { GitHubAppRecord } from "@derive/core"
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { Handler } from "hono"
import type { BlankEnv } from "hono/types"
import type { AppContext } from "../context"
import {
  installationPickerHTML,
  MANIFEST_PERMISSIONS,
  REQUIRED_EVENTS,
  REQUIRED_PERMISSIONS,
} from "../github-app-setup"
import { decryptSecret, safeEqual, signState, verifyState } from "../lib/crypto"
import {
  configureAppWebhook,
  exchangeGithubUserCode,
  GitHubError,
  getAppInfo,
  getAppInstallation,
  getAppWebhookConfig,
  getUserInstallation,
  githubWebhookSecret,
  githubWebhookSignature,
  listAppInstallations,
  listUserInstallations,
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

interface DiscoveryState {
  kind: "github-install-discover"
  org: string
  uid: string
  iat: number
}

interface SelectionState {
  kind: "github-install-select"
  org: string
  uid: string
  installationId: string
  iat: number
}

const installationIdIsValid = (value: string | undefined): value is string =>
  !!value && /^[1-9][0-9]*$/.test(value)

export const githubRoutes = (ctx: AppContext) => {
  const {
    meta,
    deps,
    requireUser,
    requireWorkspace,
    workspaceCan,
    activeWorkspace,
    currentUser,
    isSuperAdmin,
  } = ctx
  const app = new OpenAPIHono<BlankEnv>()

  const loadApp = async (): Promise<{ app: GitHubAppRecord; pem: string } | null> => {
    if (!deps.encryptionKey) return null
    const found = await meta.getGithubApp()
    if (!found) return null
    return { app: found, pem: decryptSecret(found.private_key, deps.encryptionKey) }
  }

  const webhookUrl = new URL("/v1/github/webhook", deps.baseUrl).toString()
  const configureWebhook = async (loaded: { app: GitHubAppRecord; pem: string }) =>
    configureAppWebhook({
      appId: loaded.app.app_id,
      privateKeyPem: loaded.pem,
      url: webhookUrl,
      secret: githubWebhookSecret(loaded.app.app_id, deps.encryptionKey ?? ""),
    })

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

  const authorizationUrl = (clientId: string, state: string): string => {
    if (!deps.encryptionKey) throw new Error("GitHub authorization is not configured")
    const authorize = new URL("https://github.com/login/oauth/authorize")
    authorize.searchParams.set("client_id", clientId)
    authorize.searchParams.set(
      "redirect_uri",
      new URL("/v1/github/authorize", deps.baseUrl).toString(),
    )
    authorize.searchParams.set("state", state)
    authorize.searchParams.set(
      "code_challenge",
      codeChallenge(codeVerifier(state, deps.encryptionKey)),
    )
    authorize.searchParams.set("code_challenge_method", "S256")
    authorize.searchParams.set("prompt", "select_account")
    return authorize.toString()
  }

  const selectionPage = (
    org: string,
    uid: string,
    installations: Awaited<ReturnType<typeof listAppInstallations>>,
    encryptionKey: string,
  ): string =>
    installationPickerHTML({
      installations: installations.map((installation) => ({
        login: installation.account?.login || `Installation ${installation.id}`,
        state: signState(
          {
            kind: "github-install-select",
            org,
            uid,
            installationId: String(installation.id),
          },
          encryptionKey,
        ),
      })),
      installUrl: "/v1/github/install/new",
    })

  const Account = z.object({
    installation_id: z.string(),
    account_login: z.string().nullable(),
    connection_id: z.string().nullable(),
    state: z.enum(["active", "disconnected", "needs_reauth"]),
    permissions_state: z.enum(["ready", "approval_required", "unknown"]),
    permissions_url: z.string().nullable(),
  })
  const GithubStatus = z
    .object({
      available: z.boolean().describe("Whether this instance has a live GitHub App configured"),
      connected: z
        .boolean()
        .describe("Whether this workspace has at least one active GitHub connection"),
      app_slug: z.string().nullable(),
      app_owner_login: z.string().nullable(),
      app_permissions_state: z
        .enum(["ready", "update_required", "unknown"])
        .nullable()
        .describe(
          "Whether the instance App has every current permission and event; null when no live App exists",
        ),
      app_webhook_state: z
        .enum(["ready", "update_required", "unknown"])
        .nullable()
        .describe("Whether signed GitHub workflow completion events can reach this instance"),
      app_settings_url: z.string().nullable(),
      can_manage_app: z
        .boolean()
        .describe("Whether the caller is an instance operator who can configure the shared App"),
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
      const [loaded, connections, canManageApp] = await Promise.all([
        loadApp(),
        meta.listConnections(org, undefined, "workspace"),
        isSuperAdmin(c),
      ])

      let available = !!loaded
      let slug = loaded?.app.slug ?? null
      let appOwnerLogin: string | null = null
      let appOwnerType: string | null = null
      let basePermissionsMissing = false
      // Null means GitHub could not be checked. Do not turn a transient outage into a false
      // permission-upgrade prompt.
      let appPermissionsState: "ready" | "update_required" | "unknown" | null = loaded
        ? "unknown"
        : null
      let appWebhookState: "ready" | "update_required" | "unknown" | null = loaded
        ? "unknown"
        : null
      const rank: Record<string, number> = { read: 1, write: 2, admin: 3 }
      if (loaded) {
        try {
          const live = await getAppInfo(loaded.app.app_id, loaded.pem)
          slug = live.slug || slug
          appOwnerLogin = live.owner?.login || null
          appOwnerType = live.owner?.type || null
          if (slug && slug !== loaded.app.slug) await meta.setGithubApp({ ...loaded.app, slug })
          basePermissionsMissing = Object.entries(REQUIRED_PERMISSIONS).some(
            ([permission, level]) =>
              !live.permissions[permission] ||
              (rank[live.permissions[permission] ?? ""] ?? 0) < (rank[level] ?? 0),
          )
          const permissionsReady = Object.entries(MANIFEST_PERMISSIONS).every(
            ([permission, level]) =>
              !!live.permissions[permission] &&
              (rank[live.permissions[permission] ?? ""] ?? 0) >= (rank[level] ?? 0),
          )
          const eventsReady = REQUIRED_EVENTS.every((event) => live.events.includes(event))
          appPermissionsState = permissionsReady && eventsReady ? "ready" : "update_required"
          if (eventsReady) {
            try {
              const hook = await getAppWebhookConfig(loaded.app.app_id, loaded.pem)
              appWebhookState =
                hook.url === webhookUrl &&
                hook.contentType === "json" &&
                (hook.insecureSsl === "0" || hook.insecureSsl === "false")
                  ? "ready"
                  : "update_required"
            } catch {
              appWebhookState = "unknown"
            }
          } else {
            appWebhookState = "update_required"
          }
        } catch (err) {
          // Deleted/revoked is definitive. A network/5xx failure must not hide a working App.
          if (err instanceof GitHubError && (err.status === 401 || err.status === 404)) {
            available = false
            appPermissionsState = null
            appWebhookState = null
          }
        }
      }

      const githubConnections = connections.filter((cn) => cn.kind === "github_app")
      // A connection row is not proof the installation still exists. Check each account live so
      // Settings can distinguish a working connection from an App GitHub has removed. Treat
      // only definitive auth/not-found responses as stale; a transient GitHub outage must not
      // make healthy connections disappear.
      const staleInstallations = new Set<string>()
      const installationPermissions = new Map<
        string,
        { state: "ready" | "approval_required"; url: string | null }
      >()
      if (loaded && available) {
        await Promise.all(
          githubConnections.map(async (connection) => {
            try {
              const live = await getAppInstallation(
                loaded.app.app_id,
                loaded.pem,
                connection.broker_ref,
              )
              const permissionsReady = Object.entries(MANIFEST_PERMISSIONS).every(
                ([permission, level]) =>
                  !!live.permissions[permission] &&
                  (rank[live.permissions[permission] ?? ""] ?? 0) >= (rank[level] ?? 0),
              )
              installationPermissions.set(connection.broker_ref, {
                state: permissionsReady ? "ready" : "approval_required",
                url: permissionsReady ? null : live.htmlUrl,
              })
            } catch (err) {
              if (
                err instanceof GitHubError &&
                (err.status === 401 || err.status === 403 || err.status === 404)
              )
                staleInstallations.add(connection.broker_ref)
            }
          }),
        )
      }
      const accounts: {
        installation_id: string
        account_login: string | null
        connection_id: string | null
        state: "active" | "disconnected" | "needs_reauth"
        permissions_state: "ready" | "approval_required" | "unknown"
        permissions_url: string | null
      }[] = githubConnections.map((connection) => {
        const permissions = installationPermissions.get(connection.broker_ref)
        const usable =
          connection.status === "active" &&
          available &&
          !basePermissionsMissing &&
          !staleInstallations.has(connection.broker_ref)
        return {
          installation_id: connection.broker_ref,
          account_login: connection.scopes_label,
          connection_id: connection.id,
          permissions_state: permissions?.state ?? "unknown",
          permissions_url: permissions?.url ?? null,
          state: usable
            ? ("active" as const)
            : connection.status === "active"
              ? ("needs_reauth" as const)
              : ("disconnected" as const),
        }
      })

      return c.json({
        available,
        connected: accounts.some((account) => account.state === "active"),
        app_slug: slug,
        app_owner_login: appOwnerLogin,
        app_permissions_state: appPermissionsState,
        app_webhook_state: appWebhookState,
        app_settings_url: slug
          ? appOwnerType === "Organization" && appOwnerLogin
            ? `https://github.com/organizations/${encodeURIComponent(appOwnerLogin)}/settings/apps/${encodeURIComponent(slug)}/permissions`
            : `https://github.com/settings/apps/${encodeURIComponent(slug)}/permissions`
          : null,
        can_manage_app: canManageApp,
        accounts,
      })
    },
  )

  app.post("/v1/github/webhook/configure", async (c) => {
    const me = await requireUser(c)
    if (me instanceof Response) return me
    if (!(await isSuperAdmin(c))) return fail(c, 403, "instance operator required")
    const loaded = await loadApp()
    if (!loaded || !deps.encryptionKey) return fail(c, 404, "GitHub is not configured")
    try {
      await configureWebhook(loaded)
      return c.json({ state: "ready" as const })
    } catch (err) {
      log.warn("github webhook configuration failed", {
        error: err instanceof Error ? err.message : String(err),
      })
      return fail(c, 502, "GitHub could not update the App webhook")
    }
  })

  // authz-exempt: GitHub signs the exact raw body with the server-derived App webhook secret.
  const handleWebhook: Handler<BlankEnv> = async (c) => {
    const loaded = await loadApp()
    if (!loaded || !deps.encryptionKey) return fail(c, 404, "not found")
    const declared = Number(c.req.header("content-length") ?? "0")
    if (Number.isFinite(declared) && declared > 1_000_000) return fail(c, 413, "payload too large")
    const raw = await c.req.text()
    if (raw.length > 1_000_000) return fail(c, 413, "payload too large")
    const expected = githubWebhookSignature(
      raw,
      githubWebhookSecret(loaded.app.app_id, deps.encryptionKey),
    )
    if (!safeEqual(expected, c.req.header("x-hub-signature-256")))
      return fail(c, 401, "invalid signature")
    const event = c.req.header("x-github-event") ?? ""
    const delivery = c.req.header("x-github-delivery") ?? ""
    if (!/^[a-z_]{1,64}$/.test(event) || !/^[A-Za-z0-9-]{1,100}$/.test(delivery))
      return fail(c, 400, "invalid webhook headers")
    let payload: unknown
    try {
      payload = JSON.parse(raw)
    } catch {
      return fail(c, 400, "body must be JSON")
    }
    if (event === "workflow_run") {
      const body = payload as {
        action?: unknown
        installation?: { id?: unknown }
        repository?: { full_name?: unknown }
        workflow?: { path?: unknown }
        workflow_run?: {
          id?: unknown
          status?: unknown
          conclusion?: unknown
          html_url?: unknown
        }
      }
      if (body.action === "completed")
        log.info("github workflow run completed", {
          delivery_id: delivery,
          installation_id: body.installation?.id,
          repository: body.repository?.full_name,
          workflow: body.workflow?.path,
          run_id: body.workflow_run?.id,
          status: body.workflow_run?.status,
          conclusion: body.workflow_run?.conclusion,
          url: body.workflow_run?.html_url,
        })
    }
    return c.body(null, 202)
  }
  app.post("/v1/github/webhook", handleWebhook)
  app.post("/v1/sync/github/webhook", handleWebhook)

  // Start with GitHub user authorization. This lets Derive discover an existing installation
  // even when an older App does not redirect installation updates to its setup URL.
  app.get("/v1/github/install", async (c) => {
    const org = await requireWorkspace(c, "manage")
    if (org instanceof Response) return org
    const me = await requireUser(c)
    if (me instanceof Response) return me
    const loaded = await loadApp()
    if (!loaded || !deps.encryptionKey) return fail(c, 404, "GitHub is not configured")
    if (await isSuperAdmin(c)) {
      try {
        const installations = await listAppInstallations(loaded.app.app_id, loaded.pem)
        if (!installations.length) return c.redirect("/v1/github/install/new")
        if (installations.length === 1) {
          const installation = installations[0]
          if (!installation) return c.redirect(settingsRedirect("save"))
          await upsertGithubConnection(meta, {
            orgId: org,
            userId: me.id,
            installationId: String(installation.id),
            accountLogin: installation.account?.login ?? null,
          })
          return c.redirect(settingsRedirect("connected"))
        }
        return c.html(selectionPage(org, me.id, installations, deps.encryptionKey))
      } catch (err) {
        log.warn("github operator installation recovery failed", {
          user_id: me.id,
          error: err instanceof Error ? err.message : String(err),
        })
        return c.redirect(settingsRedirect("save"))
      }
    }
    const state = signState(
      { kind: "github-install-discover", org, uid: me.id },
      deps.encryptionKey,
    )
    return c.redirect(authorizationUrl(loaded.app.client_id, state))
  })

  // No accessible installation exists yet. GitHub returns through the setup callback after the
  // manager chooses an account and repositories.
  app.get("/v1/github/install/new", async (c) => {
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
  const handleInstallCallback: Handler<BlankEnv> = async (c) => {
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
      // An installation update is the natural repair point for an older App. Keep the install
      // usable if GitHub's hook API has a transient failure; Settings shows the remaining step.
      await configureWebhook(loaded).catch((err) =>
        log.warn("github webhook repair after installation update failed", {
          installation_id: installationId,
          error: err instanceof Error ? err.message : String(err),
        }),
      )
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
    return c.redirect(authorizationUrl(loaded.app.client_id, authorizationState))
  }

  app.get("/v1/github/callback", handleInstallCallback)
  // Apps created before GitHub became a standard integration still have this setup URL on
  // GitHub. GitHub does not expose an API that can rewrite a live App's configuration, so keep
  // the old browser callback as an alias to the same signed, workspace-scoped install flow.
  app.get("/v1/sync/github/callback", handleInstallCallback)

  app.get("/v1/github/authorize", async (c) => {
    const code = c.req.query("code")
    const stateRaw = c.req.query("state") ?? ""
    if (c.req.query("error") === "access_denied") return c.redirect(settingsRedirect("canceled"))
    if (!deps.encryptionKey || !code) return c.redirect(settingsRedirect("config"))
    const encryptionKey = deps.encryptionKey
    const state = verifyState<AuthorizationState | DiscoveryState>(stateRaw, encryptionKey)
    if (
      !state ||
      (state.kind !== "github-install-discover" &&
        (state.kind !== "github-install-authorize" || !installationIdIsValid(state.installationId)))
    )
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
        clientSecret: decryptSecret(loaded.app.client_secret, encryptionKey),
        code,
        redirectUri: new URL("/v1/github/authorize", deps.baseUrl).toString(),
        codeVerifier: codeVerifier(stateRaw, encryptionKey),
      })
      if (state.kind === "github-install-discover") {
        const installations = await listUserInstallations(userToken)
        if (!installations.length) return c.redirect("/v1/github/install/new")
        if (installations.length === 1) {
          const installation = installations[0]
          if (!installation) return c.redirect(settingsRedirect("save"))
          await upsertGithubConnection(meta, {
            orgId: state.org,
            userId: me.id,
            installationId: String(installation.id),
            accountLogin: installation.account?.login ?? null,
          })
          return c.redirect(settingsRedirect("connected"))
        }
        return c.html(selectionPage(state.org, me.id, installations, encryptionKey))
      }
      const installation = await getUserInstallation(userToken, state.installationId)
      if (!installation) {
        log.warn("github installer cannot access installation", {
          installation_id: state.installationId,
          user_id: me.id,
        })
        return c.redirect(settingsRedirect("save"))
      }
      const accountLogin = installation.account?.login ?? null
      await upsertGithubConnection(meta, {
        orgId: state.org,
        userId: me.id,
        installationId: state.installationId,
        accountLogin,
      })
      return c.redirect(settingsRedirect("connected"))
    } catch (err) {
      log.warn("github integration save failed", {
        installation_id:
          state.kind === "github-install-authorize" ? state.installationId : "discovery",
        error: err instanceof Error ? err.message : String(err),
      })
      return c.redirect(settingsRedirect("save"))
    }
  })

  app.post("/v1/github/select", async (c) => {
    const org = await requireWorkspace(c, "manage")
    if (org instanceof Response) return org
    const me = await requireUser(c)
    if (me instanceof Response) return me
    if (!deps.encryptionKey) return c.redirect(settingsRedirect("config"))
    const body = await c.req.parseBody()
    const stateRaw = typeof body.state === "string" ? body.state : ""
    const state = verifyState<SelectionState>(stateRaw, deps.encryptionKey)
    if (
      state?.kind !== "github-install-select" ||
      !installationIdIsValid(state.installationId) ||
      state.org !== org ||
      state.uid !== me.id
    )
      return c.redirect(settingsRedirect("expired"))
    const loaded = await loadApp()
    if (!loaded) return c.redirect(settingsRedirect("config"))
    try {
      const installation = await getAppInstallation(
        loaded.app.app_id,
        loaded.pem,
        state.installationId,
      )
      await upsertGithubConnection(meta, {
        orgId: org,
        userId: me.id,
        installationId: state.installationId,
        accountLogin: installation.account?.login ?? null,
      })
      return c.redirect(settingsRedirect("connected"))
    } catch (err) {
      log.warn("github installation selection failed", {
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
