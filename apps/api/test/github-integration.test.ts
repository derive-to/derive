import { generateKeyPairSync } from "node:crypto"
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose"
import { afterEach, describe, expect, it, vi } from "vitest"
import { encryptSecret, signState } from "../src/lib/crypto"
import { githubWebhookSecret, githubWebhookSignature } from "../src/lib/github-app"
import { upsertGithubConnection } from "../src/lib/github-connection"
import {
  dispatchGithubWorkflowRun,
  exchangeGithubWorkflowCapability,
  GITHUB_OIDC_ISSUER,
  newGithubWorkflowExecution,
  parseGithubWorkflowExecution,
  reconcileGithubWorkflowRun,
  verifyGithubOidc,
} from "../src/lib/github-workflow-harness"
import { as, jsonAs, makeAuthedApp, type quotaApp, type TestUser } from "./helpers"

// A real RSA key (PKCS#1, as GitHub's manifest returns) so appJwt/getAppInfo can
// actually sign during the auto-heal check.
const { privateKey: RSA_PEM } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
})

const KEY = "test-encryption-key"
afterEach(() => vi.unstubAllGlobals())
const seedApp = async (meta: Awaited<ReturnType<typeof quotaApp>>["meta"]) => {
  await meta.setGithubApp({
    id: "default",
    app_id: "1",
    slug: "derive-test",
    client_id: "Iv1.x",
    client_secret: encryptSecret("cs", KEY),
    private_key: encryptSecret(RSA_PEM, KEY),
    created_at: "2026-06-15T00:00:00.000Z",
  })
}

describe("standard GitHub integration", () => {
  const owner: TestUser = {
    id: "u_gh_standard_owner",
    email: "gh-standard@derive.test",
    name: "Owner",
  }
  const member: TestUser = {
    id: "u_gh_standard_member",
    email: "gh-standard-member@derive.test",
    name: "Member",
  }

  it("lets a GitHub job reach the OIDC exchange before it has a Derive principal", async () => {
    const { app } = makeAuthedApp("gh-exchange-door", [owner], "editor", {
      deps: { encryptionKey: KEY },
    })
    const response = await app.request("/v1/workflow-runs/wfr_missing/github/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        nonce: "one-time-assignment-nonce",
        oidcToken: "header.payload.signature".repeat(10),
      }),
    })
    // The route's exact run/nonce/OIDC checks are the authentication gate. A 409 for the
    // missing assignment proves the global anonymous-write firewall did not stop the signed
    // exchange at 403 before those checks could run.
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: "GitHub workflow exchange failed" })
  })

  it("configures and verifies the signed App webhook without a browser-held secret", async () => {
    const { app, meta } = makeAuthedApp("gh-webhook", [owner], "editor", {
      deps: { encryptionKey: KEY },
      operatorIds: [owner.id],
    })
    await seedApp(meta)
    let configured: Record<string, unknown> | null = null
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        if (new URL(String(url)).pathname !== "/app/hook/config")
          return new Response("not found", { status: 404 })
        configured = JSON.parse(String(init?.body)) as Record<string, unknown>
        return new Response(
          JSON.stringify({
            url: configured.url,
            content_type: configured.content_type,
            insecure_ssl: configured.insecure_ssl,
            secret: "********",
          }),
          { status: 200 },
        )
      }),
    )

    const repair = await app.request("/v1/github/webhook/configure", {
      method: "POST",
      headers: as(owner.email),
    })
    expect(repair.status).toBe(200)
    expect(configured).toEqual({
      url: "http://derive.test/v1/github/webhook",
      content_type: "json",
      insecure_ssl: "0",
      secret: githubWebhookSecret("1", KEY),
    })

    const body = JSON.stringify({
      action: "completed",
      installation: { id: 44001 },
      repository: { full_name: "Niftory/sift" },
      workflow: { path: ".github/workflows/derive-docs-refresh.yml" },
      workflow_run: {
        id: 91,
        status: "completed",
        conclusion: "success",
        html_url: "https://github.com/Niftory/sift/actions/runs/91",
      },
    })
    const webhookHeaders = {
      "content-type": "application/json",
      "x-github-event": "workflow_run",
      "x-github-delivery": "delivery-1",
    }
    expect(
      (
        await app.request("/v1/github/webhook", {
          method: "POST",
          headers: { ...webhookHeaders, "x-hub-signature-256": "sha256=wrong" },
          body,
        })
      ).status,
    ).toBe(401)
    const signature = githubWebhookSignature(body, githubWebhookSecret("1", KEY))
    expect(
      (
        await app.request("/v1/github/webhook", {
          method: "POST",
          headers: { ...webhookHeaders, "x-hub-signature-256": signature },
          body,
        })
      ).status,
    ).toBe(202)
    expect(
      (
        await app.request("/v1/sync/github/webhook", {
          method: "POST",
          headers: { ...webhookHeaders, "x-hub-signature-256": signature },
          body,
        })
      ).status,
    ).toBe(202)
  })

  it("turns an install callback into one stable source without collection work", async () => {
    const { app, meta } = makeAuthedApp("gh-standard", [owner, member], "editor", {
      deps: { encryptionKey: KEY },
    })
    await seedApp(meta)
    // GitHub is no longer a generic source a caller can manufacture. Only the verified,
    // dedicated installation callback below may create its workspace connection.
    const generic = await app.request(
      "/v1/connections",
      jsonAs(as(owner.email), { kind: "github_app" }),
    )
    expect(generic.status).toBe(400)
    const install = await app.request("/v1/github/install", { headers: as(owner.email) })
    expect(install.status).toBe(302)
    expect(new URL(install.headers.get("location") ?? "").pathname).toBe("/login/oauth/authorize")
    const freshInstall = await app.request("/v1/github/install/new", {
      headers: as(owner.email),
    })
    expect(freshInstall.headers.get("location")).toContain(
      "https://github.com/apps/derive-test/installations/new?state=",
    )
    expect((await app.request("/v1/github/install", { headers: as(member.email) })).status).toBe(
      403,
    )
    let pullPermission = "write"
    let actionsPermission: string | undefined = "write"
    let workflowRunEvent = true
    let installationActionsPermission: string | undefined = "write"
    let installationPullPermission: string | undefined = "write"
    let appStatus = 200
    let installationStatus = 200
    const oauthCodes: string[] = []
    const oauthVerifiers: string[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const parsed = new URL(String(url))
        const path = parsed.pathname
        if (path === "/app/installations/44001")
          return new Response(
            JSON.stringify({
              id: 44001,
              account: { login: "derive-to", type: "Organization" },
              html_url: "https://github.com/organizations/derive-to/settings/installations/44001",
              permissions: {
                ...(installationActionsPermission
                  ? { actions: installationActionsPermission }
                  : {}),
                metadata: "read",
                ...(installationPullPermission
                  ? { pull_requests: installationPullPermission }
                  : {}),
              },
            }),
            { status: installationStatus },
          )
        if (parsed.host === "github.com" && path === "/login/oauth/access_token") {
          const body = new URLSearchParams(String(init?.body))
          oauthCodes.push(body.get("code") ?? "")
          oauthVerifiers.push(body.get("code_verifier") ?? "")
          expect(body.get("client_id")).toBe("Iv1.x")
          expect(body.get("client_secret")).toBe("cs")
          expect(body.get("redirect_uri")).toBe("http://derive.test/v1/github/authorize")
          return new Response(JSON.stringify({ access_token: `ghu_${body.get("code")}` }), {
            status: 200,
          })
        }
        if (path === "/user/installations")
          return new Response(
            JSON.stringify({
              installations: [{ id: 44001, account: { login: "derive-to", type: "Organization" } }],
            }),
            { status: 200 },
          )
        if (path === "/app/hook/config")
          return new Response(
            JSON.stringify({
              url: "http://derive.test/v1/github/webhook",
              content_type: "json",
              insecure_ssl: "0",
              secret: "********",
            }),
            { status: 200 },
          )
        if (path === "/app")
          return new Response(
            JSON.stringify({
              slug: "derive-test",
              owner: { login: "derive-to", type: "Organization" },
              permissions: {
                ...(actionsPermission ? { actions: actionsPermission } : {}),
                metadata: "read",
                pull_requests: pullPermission,
              },
              events: workflowRunEvent ? ["workflow_run"] : [],
            }),
            { status: appStatus },
          )
        return new Response("not found", { status: 404 })
      }),
    )
    const state = signState({ kind: "github-install-setup", org: "default", uid: owner.id }, KEY)
    const callback = (id: string) =>
      app.request(`/v1/github/callback?installation_id=${id}&state=${encodeURIComponent(state)}`, {
        headers: as(owner.email),
      })
    const legacyCallback = (id: string) =>
      app.request(
        `/v1/sync/github/callback?installation_id=${id}&setup_action=install&state=${encodeURIComponent(state)}`,
        { headers: as(owner.email) },
      )
    const authorize = (location: string | null, code: string) => {
      const oauth = new URL(location ?? "")
      expect(oauth.origin).toBe("https://github.com")
      expect(oauth.pathname).toBe("/login/oauth/authorize")
      expect(oauth.searchParams.get("client_id")).toBe("Iv1.x")
      expect(oauth.searchParams.get("redirect_uri")).toBe("http://derive.test/v1/github/authorize")
      expect(oauth.searchParams.get("code_challenge_method")).toBe("S256")
      expect(oauth.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/)
      const oauthState = oauth.searchParams.get("state") ?? ""
      return app.request(
        `/v1/github/authorize?code=${encodeURIComponent(code)}&state=${encodeURIComponent(oauthState)}`,
        { headers: as(owner.email) },
      )
    }

    const [firstSetup, concurrentSetup] = await Promise.all([callback("44001"), callback("44001")])
    expect(firstSetup.status).toBe(302)
    expect(concurrentSetup.status).toBe(302)
    expect(await meta.listConnections("default", undefined, "workspace")).toEqual([])

    const [first, concurrentReplay] = await Promise.all([
      authorize(firstSetup.headers.get("location"), "first"),
      authorize(concurrentSetup.headers.get("location"), "concurrent"),
    ])
    expect(first.headers.get("location")).toContain("/settings/integrations?github_connected=1")
    expect(concurrentReplay.headers.get("location")).toContain("github_connected=1")
    expect(oauthCodes).toEqual(expect.arrayContaining(["first", "concurrent"]))
    expect(oauthVerifiers).toHaveLength(2)
    expect(oauthVerifiers.every((verifier) => /^[A-Za-z0-9_-]{43}$/.test(verifier))).toBe(true)
    const [created] = (await meta.listConnections("default", undefined, "workspace")).filter(
      (connection) => connection.kind === "github_app",
    )
    expect(created).toMatchObject({
      kind: "github_app",
      broker_ref: "44001",
      toolkit: "github",
      status: "active",
      secret_enc: null,
    })
    expect(await meta.listCollections("default")).toEqual([])

    const legacySetup = await legacyCallback("44001")
    expect(legacySetup.status).toBe(302)
    expect(new URL(legacySetup.headers.get("location") ?? "").pathname).toBe(
      "/login/oauth/authorize",
    )
    const reconnectSetup = await callback("44001")
    const replay = await authorize(reconnectSetup.headers.get("location"), "replay")
    expect(replay.headers.get("location")).toContain("github_connected=1")
    const rows = (await meta.listConnections("default", undefined, "workspace")).filter(
      (connection) => connection.kind === "github_app",
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe(created?.id)

    const status = await app.request("/v1/github", { headers: as(owner.email) })
    expect(status.status).toBe(200)
    expect(await status.json()).toMatchObject({
      available: true,
      connected: true,
      app_owner_login: "derive-to",
      app_permissions_state: "ready",
      app_settings_url:
        "https://github.com/organizations/derive-to/settings/apps/derive-test/permissions",
      can_manage_app: false,
      accounts: [
        {
          installation_id: "44001",
          account_login: "derive-to",
          connection_id: created?.id,
          state: "active",
          permissions_state: "ready",
          permissions_url: null,
        },
      ],
    })
    pullPermission = "read"
    expect(
      await (await app.request("/v1/github", { headers: as(owner.email) })).json(),
    ).toMatchObject({ app_permissions_state: "update_required" })
    pullPermission = "write"
    actionsPermission = undefined
    expect(
      await (await app.request("/v1/github", { headers: as(owner.email) })).json(),
    ).toMatchObject({ app_permissions_state: "update_required", connected: true })
    actionsPermission = "write"
    workflowRunEvent = false
    expect(
      await (await app.request("/v1/github", { headers: as(owner.email) })).json(),
    ).toMatchObject({ app_permissions_state: "update_required", connected: true })
    workflowRunEvent = true
    installationActionsPermission = undefined
    expect(
      await (await app.request("/v1/github", { headers: as(owner.email) })).json(),
    ).toMatchObject({
      app_permissions_state: "ready",
      accounts: [
        {
          permissions_state: "approval_required",
          permissions_url:
            "https://github.com/organizations/derive-to/settings/installations/44001",
        },
      ],
    })
    installationActionsPermission = "write"
    installationPullPermission = undefined
    expect(
      await (await app.request("/v1/github", { headers: as(owner.email) })).json(),
    ).toMatchObject({
      app_permissions_state: "ready",
      accounts: [
        {
          permissions_state: "approval_required",
          permissions_url:
            "https://github.com/organizations/derive-to/settings/installations/44001",
        },
      ],
    })
    installationPullPermission = "write"
    appStatus = 500
    expect(
      await (await app.request("/v1/github", { headers: as(owner.email) })).json(),
    ).toMatchObject({ app_permissions_state: "unknown", available: true, connected: true })
    appStatus = 200
    installationStatus = 404
    expect(
      await (await app.request("/v1/github", { headers: as(owner.email) })).json(),
    ).toMatchObject({
      connected: false,
      accounts: [{ installation_id: "44001", state: "needs_reauth" }],
    })
    installationStatus = 200

    const disconnected = await app.request(`/v1/github/connections/${created?.id}`, {
      method: "DELETE",
      headers: as(owner.email),
    })
    expect(disconnected.status).toBe(204)
    expect(await meta.getConnection(created?.id ?? "")).toMatchObject({ status: "revoked" })

    const recovered = await authorize(install.headers.get("location"), "reconnect")
    expect(recovered.headers.get("location")).toContain("github_connected=1")
    expect(await meta.getConnection(created?.id ?? "")).toMatchObject({ status: "active" })
    expect(
      (await meta.listConnections("default", undefined, "workspace")).filter(
        (connection) => connection.kind === "github_app",
      ),
    ).toHaveLength(1)
  })

  it("recovers the shared App for an instance operator without GitHub OAuth", async () => {
    const { app, meta } = makeAuthedApp("gh-standard-operator", [owner], "editor", {
      deps: { encryptionKey: KEY },
      operatorIds: [owner.id],
    })
    await seedApp(meta)
    let installations = [
      {
        id: 56001,
        account: { login: "derive-operator", type: "Organization" },
        permissions: { actions: "write", metadata: "read", pull_requests: "write" },
      },
    ]
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const parsed = new URL(String(url))
        if (parsed.pathname === "/app/installations")
          return new Response(JSON.stringify(installations), { status: 200 })
        return new Response("not found", { status: 404 })
      }),
    )

    const recovered = await app.request("/v1/github/install", { headers: as(owner.email) })
    expect(recovered.headers.get("location")).toContain("github_connected=1")
    expect(
      (await meta.listConnections("default", undefined, "workspace")).filter(
        (connection) => connection.kind === "github_app",
      ),
    ).toMatchObject([{ broker_ref: "56001", scopes_label: "derive-operator", status: "active" }])

    installations = []
    const fresh = await app.request("/v1/github/install", { headers: as(owner.email) })
    expect(fresh.headers.get("location")).toBe("/v1/github/install/new")
  })

  it("lets a manager choose between existing installations without an install callback", async () => {
    const { app, meta } = makeAuthedApp("gh-standard-existing", [owner], "editor", {
      deps: { encryptionKey: KEY },
    })
    await seedApp(meta)
    let installations = [
      { id: 55001, account: { login: "derive-one", type: "Organization" } },
      { id: 55002, account: { login: "derive-two", type: "Organization" } },
    ]
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const parsed = new URL(String(url))
        if (parsed.host === "github.com" && parsed.pathname === "/login/oauth/access_token")
          return new Response(JSON.stringify({ access_token: "ghu_existing" }), { status: 200 })
        if (parsed.pathname === "/user/installations")
          return new Response(JSON.stringify({ installations }), { status: 200 })
        if (parsed.pathname === "/app/installations/55002")
          return new Response(
            JSON.stringify({
              id: 55002,
              account: { login: "derive-two", type: "Organization" },
              permissions: { actions: "write", metadata: "read", pull_requests: "write" },
            }),
            { status: 200 },
          )
        return new Response("not found", { status: 404 })
      }),
    )

    const install = await app.request("/v1/github/install", { headers: as(owner.email) })
    const oauth = new URL(install.headers.get("location") ?? "")
    const picker = await app.request(
      `/v1/github/authorize?code=existing&state=${encodeURIComponent(oauth.searchParams.get("state") ?? "")}`,
      { headers: as(owner.email) },
    )
    expect(picker.status).toBe(200)
    const html = await picker.text()
    expect(html).toContain("Choose a GitHub account")
    expect(html).toContain("derive-one")
    expect(html).toContain("derive-two")
    expect(html).toContain("/v1/github/install/new")
    const selectionStates = [...html.matchAll(/name="state" value="([^"]+)"/g)].map(
      (match) => match[1] ?? "",
    )
    expect(selectionStates).toHaveLength(2)

    const forged = await app.request("/v1/github/select", {
      method: "POST",
      headers: { ...as(owner.email), "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ state: "forged" }),
    })
    expect(forged.headers.get("location")).toContain("github_error=expired")
    expect(await meta.listConnections("default", undefined, "workspace")).toEqual([])

    const selected = await app.request("/v1/github/select", {
      method: "POST",
      headers: { ...as(owner.email), "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ state: selectionStates[1] ?? "" }),
    })
    expect(selected.headers.get("location")).toContain("github_connected=1")
    expect(
      (await meta.listConnections("default", undefined, "workspace")).filter(
        (connection) => connection.kind === "github_app",
      ),
    ).toMatchObject([{ broker_ref: "55002", scopes_label: "derive-two", status: "active" }])

    installations = []
    const emptyInstall = await app.request("/v1/github/install", { headers: as(owner.email) })
    const emptyOauth = new URL(emptyInstall.headers.get("location") ?? "")
    const noExisting = await app.request(
      `/v1/github/authorize?code=empty&state=${encodeURIComponent(emptyOauth.searchParams.get("state") ?? "")}`,
      { headers: as(owner.email) },
    )
    expect(noExisting.headers.get("location")).toBe("/v1/github/install/new")
  })

  it("rejects a forged standard callback before it records an installation", async () => {
    const { app, meta } = makeAuthedApp("gh-standard-forged", [owner, member], "editor", {
      deps: { encryptionKey: KEY },
    })
    await seedApp(meta)
    const res = await app.request("/v1/github/callback?installation_id=44002&state=forged", {
      headers: as(owner.email),
    })
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toContain("github_error=expired")
    expect(await meta.listConnections("default", undefined, "workspace")).toEqual([])

    const legacy = await app.request(
      "/v1/sync/github/callback?installation_id=44002&setup_action=install&state=forged",
      { headers: as(owner.email) },
    )
    expect(legacy.headers.get("location")).toContain("github_error=expired")
    const ownerState = signState(
      { kind: "github-install-setup", org: "default", uid: owner.id },
      KEY,
    )
    const wrongSession = await app.request(
      `/v1/github/callback?installation_id=44002&state=${encodeURIComponent(ownerState)}`,
      { headers: as(member.email) },
    )
    expect(wrongSession.headers.get("location")).toContain("github_error=expired")
    expect(await meta.listConnections("default", undefined, "workspace")).toEqual([])
  })

  it("allows a direct GitHub install only after manager login and user-access proof", async () => {
    const { app, meta } = makeAuthedApp("gh-standard-direct", [owner, member], "editor", {
      deps: { encryptionKey: KEY },
    })
    await seedApp(meta)
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const parsed = new URL(String(url))
        const installationId = parsed.pathname.split("/").at(-1)
        if (parsed.host === "github.com")
          return new Response(JSON.stringify({ access_token: "ghu_direct" }), { status: 200 })
        if (parsed.pathname === "/user/installations")
          return new Response(
            JSON.stringify({
              installations: [{ id: 44003, account: { login: "derive-to", type: "Organization" } }],
            }),
            { status: 200 },
          )
        return new Response(
          JSON.stringify({
            id: Number(installationId),
            account: { login: "derive-to", type: "Organization" },
          }),
          { status: 200 },
        )
      }),
    )

    const ownerResult = await app.request("/v1/github/callback?installation_id=44003", {
      headers: as(owner.email),
    })
    const oauth = new URL(ownerResult.headers.get("location") ?? "")
    expect(oauth.pathname).toBe("/login/oauth/authorize")
    expect(await meta.listConnections("default", undefined, "workspace")).toEqual([])
    const authorized = await app.request(
      `/v1/github/authorize?code=direct&state=${encodeURIComponent(oauth.searchParams.get("state") ?? "")}`,
      { headers: as(owner.email) },
    )
    expect(authorized.headers.get("location")).toContain("github_connected=1")
    expect(await meta.listConnections("default", undefined, "workspace")).toEqual([
      expect.objectContaining({ broker_ref: "44003", org_id: "default" }),
    ])

    const memberResult = await app.request("/v1/github/callback?installation_id=44004", {
      headers: as(member.email),
    })
    expect(memberResult.headers.get("location")).toContain("github_error=expired")

    const anonymousResult = await app.request("/v1/github/callback?installation_id=44005")
    expect(anonymousResult.headers.get("location")).toContain("/login?return_to=")

    const anonymousLegacyResult = await app.request(
      "/v1/sync/github/callback?installation_id=44005&setup_action=install",
    )
    expect(anonymousLegacyResult.headers.get("location")).toContain(
      "return_to=%2Fv1%2Fsync%2Fgithub%2Fcallback",
    )
  })

  it("refuses an installation the authorizing GitHub user cannot access", async () => {
    const { app, meta } = makeAuthedApp("gh-standard-user-proof", [owner], "editor", {
      deps: { encryptionKey: KEY },
    })
    await seedApp(meta)
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const parsed = new URL(String(url))
        if (parsed.pathname === "/app/installations/44006")
          return new Response(
            JSON.stringify({ id: 44006, account: { login: "other-org", type: "Organization" } }),
            { status: 200 },
          )
        if (parsed.host === "github.com")
          return new Response(JSON.stringify({ access_token: "ghu_unrelated" }), { status: 200 })
        if (parsed.pathname === "/user/installations")
          return new Response(JSON.stringify({ installations: [] }), { status: 200 })
        return new Response("not found", { status: 404 })
      }),
    )
    const state = signState({ kind: "github-install-setup", org: "default", uid: owner.id }, KEY)
    const setup = await app.request(
      `/v1/github/callback?installation_id=44006&state=${encodeURIComponent(state)}`,
      { headers: as(owner.email) },
    )
    const oauth = new URL(setup.headers.get("location") ?? "")
    const authorized = await app.request(
      `/v1/github/authorize?code=unrelated&state=${encodeURIComponent(oauth.searchParams.get("state") ?? "")}`,
      { headers: as(owner.email) },
    )
    expect(authorized.headers.get("location")).toContain("github_error=save")
    expect(await meta.listConnections("default", undefined, "workspace")).toEqual([])
  })

  it("binds one GitHub installation independently to multiple Derive workspaces", async () => {
    const { meta } = makeAuthedApp("gh-standard-multi-workspace", [owner], "editor")
    await meta.setWorkspace("second", "Second workspace")
    await meta.setMembership({
      id: "m_gh_second",
      org_id: "second",
      user_id: owner.id,
      role: "owner",
    })

    const first = await upsertGithubConnection(meta, {
      orgId: "default",
      userId: owner.id,
      installationId: "44007",
      accountLogin: "derive-to",
    })
    const second = await upsertGithubConnection(meta, {
      orgId: "second",
      userId: owner.id,
      installationId: "44007",
      accountLogin: "derive-to",
    })

    expect(first.id).not.toBe(second.id)
    expect(await meta.listConnections("default", undefined, "workspace")).toEqual([
      expect.objectContaining({ id: first.id, broker_ref: "44007" }),
    ])
    expect(await meta.listConnections("second", undefined, "workspace")).toEqual([
      expect.objectContaining({ id: second.id, broker_ref: "44007" }),
    ])
  })

  const seedHarnessRun = async (name: string, githubRunId = "91001") => {
    const { meta } = makeAuthedApp(`gh-harness-${name}`, [owner], "editor", {
      deps: { encryptionKey: KEY },
    })
    const connection = await upsertGithubConnection(meta, {
      orgId: "default",
      userId: owner.id,
      installationId: "44001",
      accountLogin: "Niftory",
    })
    const agent = await meta.createAgent({
      id: `agt_${name}`,
      org_id: "default",
      name: "GitHub graph runner",
      token: `hashed_${name}`,
      role: "editor",
      created_by: owner.id,
    })
    const nonce = `dkx_${name}_0123456789abcdef`
    const baseAssignment = await newGithubWorkflowExecution({
      connectionId: connection.id,
      installationId: connection.broker_ref,
      owner: "Niftory",
      repo: "sift",
      workflow: "derive-graph-runner.yml",
      ref: "main",
      nonce,
      now: new Date("2026-08-31T00:00:00.000Z"),
    })
    const assignment = {
      ...baseAssignment,
      github_run_id: githubRunId,
      github_run_url: `https://github.com/Niftory/sift/actions/runs/${githubRunId}`,
      github_status: "dispatched",
    }
    const created = await meta.createWorkflowRun({
      id: `wfr_${name}`,
      org_id: "default",
      workflow_artifact_id: `art_${name}`,
      workflow_version: 3,
      workflow_blob_key: `blob_${name}`,
      workflow_content_type: "text/x-derive-linked-bundle",
      diagram_id: "main",
      reason: "github-actions",
      initiated_by: owner.id,
      assigned_agent_id: agent.id,
      requested_execution: "github_actions",
      external_execution: JSON.stringify(baseAssignment),
      created_at: "2026-08-31T00:00:00.000Z",
    })
    const dispatched = await meta.transitionWorkflowRun(
      created.id,
      created.org_id,
      { status: "queued", stateRevision: 0 },
      {
        status: "dispatched",
        at: "2026-08-31T00:00:01.000Z",
        externalExecution: JSON.stringify(assignment),
        externalRunId: `Niftory/sift#${githubRunId}`,
      },
    )
    if (!dispatched) throw new Error("failed to seed dispatched run")
    return { meta, run: dispatched, assignment, nonce, agent }
  }

  it("records dispatch failure and sends only bounded identifiers to the adapter", async () => {
    const { meta } = makeAuthedApp("gh-harness-dispatch", [owner], "editor", {
      deps: { encryptionKey: KEY },
    })
    await seedApp(meta)
    const connection = await upsertGithubConnection(meta, {
      orgId: "default",
      userId: owner.id,
      installationId: "44001",
      accountLogin: "Niftory",
    })
    const agent = await meta.createAgent({
      id: "agt_dispatch_failure",
      org_id: "default",
      name: "GitHub graph runner",
      token: "hashed-dispatch-agent-token",
      role: "editor",
      created_by: owner.id,
    })
    const nonce = "dkx_dispatch_failure_0123456789abcdef"
    const assignment = await newGithubWorkflowExecution({
      connectionId: connection.id,
      installationId: connection.broker_ref,
      owner: "Niftory",
      repo: "sift",
      workflow: "derive-graph-runner.yml",
      ref: "main",
      nonce,
    })
    const run = await meta.createWorkflowRun({
      id: "wfr_dispatch_failure",
      org_id: "default",
      workflow_artifact_id: "art_dispatch_failure",
      workflow_version: 1,
      workflow_blob_key: "blob_dispatch_failure",
      workflow_content_type: "text/x-derive-linked-bundle",
      diagram_id: "main",
      reason: "github-actions",
      initiated_by: owner.id,
      assigned_agent_id: agent.id,
      requested_execution: "github_actions",
      external_execution: JSON.stringify(assignment),
    })
    const requests: { path: string; body: unknown }[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const path = new URL(String(url)).pathname
        const body = init?.body ? JSON.parse(String(init.body)) : undefined
        requests.push({ path, body })
        if (path.endsWith("/access_tokens"))
          return new Response(
            JSON.stringify({
              token: "github-actions-token",
              expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            }),
            { status: 201 },
          )
        return new Response(JSON.stringify({ message: "adapter unavailable" }), { status: 503 })
      }),
    )
    await expect(
      dispatchGithubWorkflowRun({ meta, run, assignment, nonce, encryptionKey: KEY }),
    ).rejects.toThrow("GitHub refused")
    expect(requests[1]).toEqual({
      path: "/repos/Niftory/sift/actions/workflows/derive-graph-runner.yml/dispatches",
      body: {
        ref: "main",
        inputs: { derive_run_id: run.id, derive_exchange_nonce: nonce },
        return_run_details: true,
      },
    })
    const failed = await meta.getWorkflowRun(run.id, run.org_id)
    expect(failed?.status).toBe("failed")
    expect(parseGithubWorkflowExecution(failed?.external_execution ?? null)?.last_error).toContain(
      "GitHub refused",
    )
  })

  it("verifies GitHub OIDC signature, audience, expiry, and exact run claims", async () => {
    const { assignment } = await seedHarnessRun("oidc", "91002")
    const now = new Date("2026-08-31T00:02:00.000Z")
    const { privateKey, publicKey } = await generateKeyPair("ES256")
    const publicJwk = await exportJWK(publicKey)
    const key = createLocalJWKSet({ keys: [{ ...publicJwk, kid: "oidc-test", alg: "ES256" }] })
    const claims = {
      repository: "Niftory/sift",
      workflow_ref: "Niftory/sift/.github/workflows/derive-graph-runner.yml@refs/heads/main",
      ref: "refs/heads/main",
      run_id: "91002",
      run_attempt: "1",
      event_name: "workflow_dispatch",
    }
    const sign = (overrides: Record<string, unknown> = {}) =>
      new SignJWT({ ...claims, ...overrides })
        .setProtectedHeader({ alg: "ES256", kid: "oidc-test" })
        .setIssuer(GITHUB_OIDC_ISSUER)
        .setAudience("derive-graph-runner")
        .setSubject("repo:Niftory/sift:ref:refs/heads/main")
        .setIssuedAt(Math.floor(now.getTime() / 1000))
        .setExpirationTime(Math.floor(now.getTime() / 1000) + 300)
        .sign(privateKey)
    await expect(verifyGithubOidc(await sign(), assignment, { now, key })).resolves.toMatchObject({
      runId: "91002",
      runAttempt: 1,
    })
    const immutableSubject = await new SignJWT(claims)
      .setProtectedHeader({ alg: "ES256", kid: "oidc-test" })
      .setIssuer(GITHUB_OIDC_ISSUER)
      .setAudience("derive-graph-runner")
      .setSubject("repo:Niftory@123456:sift@987654:ref:refs/heads/main")
      .setIssuedAt(Math.floor(now.getTime() / 1000))
      .setExpirationTime(Math.floor(now.getTime() / 1000) + 300)
      .sign(privateKey)
    await expect(
      verifyGithubOidc(immutableSubject, assignment, { now, key }),
    ).resolves.toMatchObject({ runId: "91002", runAttempt: 1 })
    await expect(
      verifyGithubOidc(
        await sign({
          ref: "refs/tags/main",
          workflow_ref: "Niftory/sift/.github/workflows/derive-graph-runner.yml@refs/tags/main",
        }),
        assignment,
        { now, key },
      ),
    ).resolves.toMatchObject({ ref: "refs/tags/main" })
    for (const invalid of [
      { repository: "Other/sift" },
      { workflow_ref: "Niftory/sift/.github/workflows/release.yml@refs/heads/main" },
      { ref: "refs/heads/other" },
      { run_id: "91003" },
    ])
      await expect(verifyGithubOidc(await sign(invalid), assignment, { now, key })).rejects.toThrow(
        "does not match",
      )
    const wrongAudience = await new SignJWT(claims)
      .setProtectedHeader({ alg: "ES256", kid: "oidc-test" })
      .setIssuer(GITHUB_OIDC_ISSUER)
      .setAudience("wrong-audience")
      .setSubject("repo:Niftory/sift:ref:refs/heads/main")
      .setIssuedAt(Math.floor(now.getTime() / 1000))
      .setExpirationTime(Math.floor(now.getTime() / 1000) + 300)
      .sign(privateKey)
    await expect(verifyGithubOidc(wrongAudience, assignment, { now, key })).rejects.toThrow()
    await expect(
      verifyGithubOidc(
        await new SignJWT(claims)
          .setProtectedHeader({ alg: "ES256", kid: "oidc-test" })
          .setIssuer(GITHUB_OIDC_ISSUER)
          .setAudience("derive-graph-runner")
          .setSubject("repo:Niftory/sift:ref:refs/heads/main")
          .setIssuedAt(Math.floor(now.getTime() / 1000) - 900)
          .setExpirationTime(Math.floor(now.getTime() / 1000) - 1)
          .sign(privateKey),
        assignment,
        { now, key },
      ),
    ).rejects.toThrow()
    const other = await generateKeyPair("ES256")
    await expect(
      verifyGithubOidc(await sign(), assignment, {
        now,
        key: createLocalJWKSet({
          keys: [{ ...(await exportJWK(other.publicKey)), kid: "oidc-test", alg: "ES256" }],
        }),
      }),
    ).rejects.toThrow()
  })

  it("mints one fixed-expiry capability and makes only the same run attempt retry idempotent", async () => {
    const { meta, run, nonce } = await seedHarnessRun("exchange", "91004")
    const identity = {
      subject: "repo:Niftory/sift:ref:refs/heads/main",
      repository: "Niftory/sift",
      workflowRef: "Niftory/sift/.github/workflows/derive-graph-runner.yml@refs/heads/main",
      ref: "refs/heads/main",
      runId: "91004",
      runAttempt: 1,
    }
    const exchange = (verify = vi.fn(async () => identity), nonceValue = nonce) =>
      exchangeGithubWorkflowCapability({
        meta,
        runId: run.id,
        nonce: nonceValue,
        oidcToken: "header.payload.signature",
        encryptionKey: KEY,
        instruction: () => "exact pinned instruction",
        baseUrl: "https://derive.to",
        now: new Date("2026-08-31T00:02:00.000Z"),
        verify,
      })
    const first = await exchange()
    const retry = await exchange()
    expect(retry).toEqual(first)
    expect(first).toMatchObject({
      instruction: "exact pinned instruction",
      mcpUrl: "https://derive.to/mcp",
    })
    await expect(exchange(undefined, "dkx_wrong_0123456789abcdef")).rejects.toThrow(
      "not authorized",
    )
    await expect(exchange(vi.fn(async () => ({ ...identity, runAttempt: 2 })))).rejects.toThrow()
    const stored = await meta.getWorkflowRun(run.id, run.org_id)
    expect(stored).toMatchObject({ status: "running", actual_execution: "github_actions" })
    expect(parseGithubWorkflowExecution(stored?.external_execution ?? null)).toMatchObject({
      github_run_attempt: 1,
      capability_expires_at: first.expiresAt,
    })
  })

  it("refuses an expired exchange and a run with no GitHub assignment", async () => {
    const expired = await seedHarnessRun("expired", "91007")
    const expiredAssignment = {
      ...expired.assignment,
      exchange_expires_at: "2026-08-31T00:00:01.000Z",
    }
    await expired.meta.setWorkflowRunExternalReceipt(
      expired.run.id,
      expired.run.org_id,
      "Niftory/sift#91007",
      JSON.stringify(expiredAssignment),
      "2026-08-31T00:00:01.000Z",
    )
    const verify = vi.fn(async () => ({
      subject: "repo:Niftory/sift:ref:refs/heads/main",
      repository: "Niftory/sift",
      workflowRef: "Niftory/sift/.github/workflows/derive-graph-runner.yml@refs/heads/main",
      ref: "refs/heads/main",
      runId: "91007",
      runAttempt: 1,
    }))
    await expect(
      exchangeGithubWorkflowCapability({
        meta: expired.meta,
        runId: expired.run.id,
        nonce: expired.nonce,
        oidcToken: "header.payload.signature",
        encryptionKey: KEY,
        instruction: () => "pinned",
        baseUrl: "https://derive.to",
        now: new Date("2026-08-31T00:02:00.000Z"),
        verify,
      }),
    ).rejects.toThrow("expired")
    expect(verify).not.toHaveBeenCalled()

    const unassigned = await expired.meta.createWorkflowRun({
      id: "wfr_missing_assignment",
      org_id: "default",
      workflow_artifact_id: "art_missing_assignment",
      workflow_version: 1,
      workflow_blob_key: "blob_missing_assignment",
      workflow_content_type: "text/x-derive-linked-bundle",
      diagram_id: "main",
      reason: "github-actions",
      initiated_by: owner.id,
      assigned_agent_id: expired.agent.id,
      requested_execution: "github_actions",
    })
    await expect(
      exchangeGithubWorkflowCapability({
        meta: expired.meta,
        runId: unassigned.id,
        nonce: expired.nonce,
        oidcToken: "header.payload.signature",
        encryptionKey: KEY,
        instruction: () => "pinned",
        baseUrl: "https://derive.to",
        now: new Date("2026-08-31T00:02:00.000Z"),
        verify,
      }),
    ).rejects.toThrow("not available")
  })

  it.each([
    ["cancelled", "cancelled"],
    ["timed_out", "timed_out"],
    ["failure", "failed"],
  ] as const)("settles a matching GitHub %s conclusion as %s", async (conclusion, expected) => {
    const { meta, run, assignment, agent } = await seedHarnessRun(`settle-${conclusion}`)
    const running = await meta.transitionWorkflowRun(
      run.id,
      run.org_id,
      { status: "dispatched", stateRevision: run.state_revision },
      {
        status: "running",
        at: "2026-08-31T00:02:00.000Z",
        actualExecution: "github_actions",
        executorId: agent.id,
        externalExecution: JSON.stringify({
          ...assignment,
          github_run_attempt: 1,
          oidc_subject: "repo:Niftory/sift:ref:refs/heads/main",
        }),
      },
    )
    if (!running) throw new Error("failed to seed running run")
    const settled = await reconcileGithubWorkflowRun({
      meta,
      installationId: "44001",
      repository: "Niftory/sift",
      workflowPath: ".github/workflows/derive-graph-runner.yml",
      runId: "91001",
      runAttempt: 1,
      status: "completed",
      conclusion,
      url: "https://github.com/Niftory/sift/actions/runs/91001",
      at: new Date("2026-08-31T00:03:00.000Z"),
    })
    expect(settled?.status).toBe(expected)
  })

  it("fails an unsettled graph on GitHub success but preserves and receipts a settled success", async () => {
    const unsettled = await seedHarnessRun("unsettled", "91005")
    const failed = await reconcileGithubWorkflowRun({
      meta: unsettled.meta,
      installationId: "44001",
      repository: "Niftory/sift",
      workflowPath: ".github/workflows/derive-graph-runner.yml",
      runId: "91005",
      runAttempt: 1,
      status: "completed",
      conclusion: "success",
      url: "https://github.com/Niftory/sift/actions/runs/91005",
    })
    expect(failed?.status).toBe("failed")
    expect(parseGithubWorkflowExecution(failed?.external_execution ?? null)?.last_error).toContain(
      "without a terminal successful Derive graph receipt",
    )

    const settled = await seedHarnessRun("settled", "91006")
    const running = await settled.meta.transitionWorkflowRun(
      settled.run.id,
      settled.run.org_id,
      { status: "dispatched", stateRevision: settled.run.state_revision },
      {
        status: "running",
        at: "2026-08-31T00:02:00.000Z",
        actualExecution: "github_actions",
        executorId: settled.agent.id,
        externalExecution: JSON.stringify({
          ...settled.assignment,
          github_run_attempt: 1,
          oidc_subject: "repo:Niftory/sift:ref:refs/heads/main",
        }),
      },
    )
    if (!running) throw new Error("failed to seed running run")
    const succeeded = await settled.meta.transitionWorkflowRun(
      running.id,
      running.org_id,
      { status: "running", stateRevision: running.state_revision },
      {
        status: "succeeded",
        at: "2026-08-31T00:03:00.000Z",
        actualExecution: "github_actions",
        executorId: settled.agent.id,
      },
    )
    if (!succeeded) throw new Error("failed to seed succeeded run")
    const reconciled = await reconcileGithubWorkflowRun({
      meta: settled.meta,
      installationId: "44001",
      repository: "Niftory/sift",
      workflowPath: ".github/workflows/derive-graph-runner.yml",
      runId: "91006",
      runAttempt: 1,
      status: "completed",
      conclusion: "success",
      url: "https://github.com/Niftory/sift/actions/runs/91006",
    })
    expect(reconciled?.status).toBe("succeeded")
    expect(parseGithubWorkflowExecution(reconciled?.external_execution ?? null)).toMatchObject({
      github_conclusion: "success",
      github_status: "completed",
    })
  })
})
