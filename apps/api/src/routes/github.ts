import { createHash, createHmac } from "node:crypto"
import type { GitHubAppRecord } from "@derive/core"
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { Context, Handler } from "hono"
import type { BlankEnv } from "hono/types"
import type { AppContext } from "../context"
import {
  installationPickerHTML,
  MANIFEST_PERMISSIONS,
  REQUIRED_PERMISSIONS,
} from "../github-app-setup"
import { decryptSecret, safeEqual, signState, verifyState } from "../lib/crypto"
import {
  type AppInstallation,
  exchangeGithubUserCode,
  GitHubError,
  getAppInfo,
  getAppInstallation,
  getUserInstallation,
  githubWebhookSecret,
  githubWebhookSignature,
  installationToken,
  listAppInstallations,
  listInstallationRepositories,
  listUserInstallations,
} from "../lib/github-app"
import { upsertGithubConnection } from "../lib/github-connection"
import { dispatchGithubEvent } from "../lib/github-events"
import { bail, fail } from "../lib/http"
import { graphAware } from "../lib/job-graph"
import { machineDepsFrom, machinePass } from "../lib/job-machine"
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

/** GitHub also has Enterprise accounts; only the two kinds a person would recognize get a name. */
const accountType = (type: string | undefined): "organization" | "user" | null =>
  type === "Organization" ? "organization" : type === "User" ? "user" : null

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
  const jobDeps = graphAware({
    meta,
    cloud: { secret: deps.encryptionKey, config: deps.runtime },
    bus: ctx.backplane,
    blobs: ctx.blobs,
    announce: ctx.announceJob,
  })

  const loadApp = async (): Promise<{ app: GitHubAppRecord; pem: string } | null> => {
    if (!deps.encryptionKey) return null
    const found = await meta.getGithubApp()
    if (!found) return null
    return { app: found, pem: decryptSecret(found.private_key, deps.encryptionKey) }
  }

  const settingsRedirect = (
    result: "connected" | "canceled" | "requested" | "expired" | "config" | "save",
  ): string =>
    result === "connected"
      ? "/settings/sources?github_connected=1"
      : `/settings/sources?github_error=${result}`

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

  const saveConnection = async (input: {
    orgId: string
    userId: string
    installationId: string
    accountLogin: string | null
  }) => {
    const loaded = await loadApp()
    if (!loaded) throw new Error("GitHub is not configured")
    const token = await installationToken(loaded.app.app_id, loaded.pem, input.installationId)
    await listInstallationRepositories(token, 1)
    return upsertGithubConnection(meta, input)
  }

  // Connecting never binds an installation by itself. It offers the installations this
  // workspace has not connected yet, beside the way onto GitHub's own account picker; with none
  // to offer it goes straight there. Picking the only installation for the person made every
  // other GitHub account unreachable once one was connected.
  const offerInstallations = async (
    c: Context,
    org: string,
    uid: string,
    installations: AppInstallation[],
    encryptionKey: string,
  ): Promise<Response> => {
    const connected = new Set(
      (await meta.listConnections(org, undefined, "workspace"))
        .filter((cn) => cn.kind === "github_app" && cn.status === "active")
        .map((cn) => cn.broker_ref),
    )
    const offered = installations.filter((installation) => !connected.has(String(installation.id)))
    if (!offered.length) return c.redirect("/v1/github/install/new")
    return c.html(
      installationPickerHTML({
        installations: offered.map((installation) => ({
          login: installation.account?.login || `Installation ${installation.id}`,
          type: accountType(installation.account?.type),
          avatarUrl: installation.account?.login
            ? `https://github.com/${encodeURIComponent(installation.account.login)}.png?size=64`
            : null,
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
        cancelUrl: "/settings/sources",
      }),
    )
  }

  const Account = z.object({
    installation_id: z.string(),
    account_login: z.string().nullable(),
    account_type: z.enum(["organization", "user"]).nullable(),
    connection_id: z.string(),
    state: z.enum(["active", "needs_reauth"]),
    permissions_state: z.enum(["ready", "approval_required", "unknown"]),
    permissions_url: z.string().nullable(),
    installation_url: z.string().nullable(),
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
          "Whether the instance App has every current permission; null when no live App exists",
        ),
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
      let appPermissions: Record<string, string> | null = null
      // Null means GitHub could not be checked. Do not turn a transient outage into a false
      // permission-upgrade prompt.
      let appPermissionsState: "ready" | "update_required" | "unknown" | null = loaded
        ? "unknown"
        : null
      const rank: Record<string, number> = { read: 1, write: 2, admin: 3 }
      if (loaded) {
        try {
          const live = await getAppInfo(loaded.app.app_id, loaded.pem)
          slug = live.slug || slug
          appOwnerLogin = live.owner?.login || null
          appOwnerType = live.owner?.type || null
          appPermissions = live.permissions
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
          appPermissionsState = permissionsReady ? "ready" : "update_required"
        } catch (err) {
          // Deleted/revoked is definitive. A network/5xx failure must not hide a working App.
          if (err instanceof GitHubError && (err.status === 401 || err.status === 404)) {
            available = false
            appPermissionsState = null
          }
        }
      }

      // A disconnected installation is gone from this workspace. Its row is kept only so
      // reconnecting the same installation restores the agents bound to it.
      const githubConnections = connections.filter(
        (cn) => cn.kind === "github_app" && cn.status === "active",
      )
      // A connection row is not proof the installation still exists. Check each account live so
      // Settings can distinguish a working connection from an App GitHub has removed. Treat
      // only definitive auth/not-found responses as stale; a transient GitHub outage must not
      // make healthy connections disappear.
      const staleInstallations = new Set<string>()
      const installationPermissions = new Map<
        string,
        {
          state: "ready" | "approval_required"
          url: string | null
          installationUrl: string | null
          accountType: "organization" | "user" | null
        }
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
              if (live.suspended) staleInstallations.add(connection.broker_ref)
              // An account can only approve what the App already asks for. While the App itself
              // lacks a permission, that is the App owner's step, not this account's, so the
              // account is measured against what the App holds today.
              const permissionsReady = Object.entries(MANIFEST_PERMISSIONS).every(
                ([permission, level]) => {
                  const wanted = Math.min(
                    rank[level] ?? 0,
                    appPermissions ? (rank[appPermissions[permission] ?? ""] ?? 0) : Infinity,
                  )
                  return (rank[live.permissions[permission] ?? ""] ?? 0) >= wanted
                },
              )
              installationPermissions.set(connection.broker_ref, {
                state: permissionsReady ? "ready" : "approval_required",
                url: permissionsReady ? null : live.htmlUrl,
                installationUrl: live.htmlUrl,
                accountType: accountType(live.account?.type),
              })
            } catch (err) {
              if (
                err instanceof GitHubError &&
                (err.status === 401 ||
                  (err.status === 403 && err.rateLimitRemaining !== "0") ||
                  err.status === 404)
              )
                staleInstallations.add(connection.broker_ref)
            }
          }),
        )
      }
      const accounts: z.infer<typeof Account>[] = githubConnections.map((connection) => {
        const permissions = installationPermissions.get(connection.broker_ref)
        const usable =
          available && !basePermissionsMissing && !staleInstallations.has(connection.broker_ref)
        return {
          installation_id: connection.broker_ref,
          account_login: connection.scopes_label,
          account_type: permissions?.accountType ?? null,
          connection_id: connection.id,
          permissions_state: permissions?.state ?? "unknown",
          permissions_url: permissions?.url ?? null,
          installation_url: permissions?.installationUrl ?? null,
          state: usable ? ("active" as const) : ("needs_reauth" as const),
        }
      })

      return c.json({
        available,
        connected: accounts.some((account) => account.state === "active"),
        app_slug: slug,
        app_owner_login: appOwnerLogin,
        app_permissions_state: appPermissionsState,
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

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/github/connections/{id}/repositories",
      tags: ["GitHub"],
      summary: "Read repositories available to this workspace's GitHub installation.",
      request: {
        params: z.object({ id: z.string() }),
        query: z.object({ page: z.coerce.number().int().min(1).max(10000).default(1) }),
      },
      responses: {
        200: {
          description: "One page of accessible repositories, verified with an installation token.",
          content: {
            "application/json": {
              schema: z
                .object({
                  total_count: z.number(),
                  repositories: z.array(
                    z.object({
                      id: z.number(),
                      full_name: z.string(),
                      private: z.boolean(),
                      html_url: z.string(),
                    }),
                  ),
                  has_more: z.boolean(),
                })
                .openapi("GithubRepositories"),
            },
          },
        },
      },
    }),
    async (c) => {
      const me = await requireUser(c)
      if (me instanceof Response) return bail(me)
      const org = await requireWorkspace(c, "read")
      if (org instanceof Response) return bail(org)
      const connection = await meta.getConnection(c.req.valid("param").id)
      if (
        !connection ||
        connection.org_id !== org ||
        connection.scope !== "workspace" ||
        connection.kind !== "github_app" ||
        connection.status !== "active"
      )
        return bail(fail(c, 404, "GitHub connection not found"))
      const loaded = await loadApp()
      if (!loaded) return bail(fail(c, 503, "GitHub is not configured"))
      try {
        const token = await installationToken(loaded.app.app_id, loaded.pem, connection.broker_ref)
        return c.json(await listInstallationRepositories(token, c.req.valid("query").page))
      } catch (error) {
        if (
          error instanceof GitHubError &&
          [401, 403, 404].includes(error.status) &&
          error.rateLimitRemaining !== "0"
        )
          return bail(
            fail(
              c,
              403,
              "GitHub access could not be verified. Reconnect or review repository access on GitHub.",
            ),
          )
        return bail(fail(c, 503, "GitHub repositories could not be loaded. Try again later."))
      }
    },
  )

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
    // Signed and well-formed: acknowledged at once. Matching event triggers start their tasks
    // after the response, so GitHub never waits on a machine.
    const installation = (payload as { installation?: { id?: unknown } } | null)?.installation?.id
    if (typeof installation === "number")
      await ctx.afterResponse(c, async () => {
        const started = await dispatchGithubEvent(jobDeps, {
          id: delivery,
          event,
          installationId: String(installation),
          payload,
          appBot: `${loaded.app.slug}[bot]`,
        })
        const machines = started.length
          ? machineDepsFrom(meta, {
              secret: deps.encryptionKey,
              server: deps.baseUrl,
              config: deps.runtime,
              fetcher: deps.runtimeFetch,
              bus: ctx.backplane,
              announce: ctx.announceJob,
            })
          : null
        if (machines) await machinePass(machines)
      })
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
        return await offerInstallations(c, org, me.id, installations, deps.encryptionKey)
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

  // GitHub's own account picker: install on a new account, or change which repositories an
  // existing installation covers. GitHub returns through the setup callback afterwards.
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
    if (c.req.query("setup_action") === "request") return c.redirect(settingsRedirect("requested"))
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
        return await offerInstallations(c, state.org, me.id, installations, encryptionKey)
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
      await saveConnection({
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
      await saveConnection({
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
