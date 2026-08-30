import { generateKeyPairSync } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import { encryptSecret, signState } from "../src/lib/crypto"
import { upsertGithubConnection } from "../src/lib/github-connection"
import { as, jsonAs, makeAuthedApp, type quotaApp, type TestUser } from "./helpers"

// A real RSA key (PKCS#1, as GitHub's manifest returns) so appJwt/getAppInfo can
// actually sign during the auto-heal check.
const { privateKey: RSA_PEM } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
})

const KEY = "test-encryption-key"
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
              events: [],
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
})
