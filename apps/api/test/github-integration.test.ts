import { generateKeyPairSync } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import { encryptSecret, signState } from "../src/lib/crypto"
import { githubWebhookSecret, githubWebhookSignature } from "../src/lib/github-app"
import { upsertGithubConnection } from "../src/lib/github-connection"
import { as, bearer, jsonAs, makeAuthedApp, type quotaApp, type TestUser } from "./helpers"

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

const repositoryAccessFixture = (path: string): Response | null => {
  if (/^\/app\/installations\/\d+\/access_tokens$/.test(path))
    return new Response(
      JSON.stringify({
        token: "fixture-installation-token",
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      }),
      { status: 201 },
    )
  if (path === "/installation/repositories")
    return new Response(JSON.stringify({ total_count: 0, repositories: [] }), { status: 200 })
  return null
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

  it("acknowledges only correctly signed App webhook deliveries", async () => {
    const { app, meta } = makeAuthedApp("gh-webhook", [owner], "editor", {
      deps: { encryptionKey: KEY },
    })
    await seedApp(meta)

    const body = JSON.stringify({
      action: "completed",
      installation: { id: 44001 },
      repository: { full_name: "example-org/example-repo" },
      workflow: { path: ".github/workflows/derive-docs-refresh.yml" },
      workflow_run: {
        id: 91,
        status: "completed",
        conclusion: "success",
        html_url: "https://github.com/example-org/example-repo/actions/runs/91",
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

  it("starts an agent's task when a signed GitHub event matches its trigger", async () => {
    const { app, meta } = makeAuthedApp("gh-events", [owner], "owner", {
      deps: { encryptionKey: KEY },
    })
    await seedApp(meta)
    const hooks: Record<string, unknown>[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const path = new URL(String(url)).pathname
        if (path === "/app/hook/config" && init?.method === "PATCH") {
          hooks.push(JSON.parse(String(init.body)))
          return new Response("{}", { status: 200 })
        }
        if (path === "/app")
          return new Response(
            JSON.stringify({
              slug: "derive-test",
              owner: { login: "acme", type: "User" },
              events: [],
            }),
            { status: 200 },
          )
        return new Response("not found", { status: 404 })
      }),
    )
    const source = await upsertGithubConnection(meta, {
      orgId: "default",
      userId: owner.id,
      installationId: "44010",
      accountLogin: "acme",
    })
    const create = async (body: object) =>
      (await (await app.request("/v1/agents", jsonAs(as(owner.email), body))).json()) as {
        id: string
      }
    const reviewer = await create({ name: "Reviewer", connection_ids: [source.id] })
    const loner = await create({ name: "Loner" })
    const on = {
      github: {
        event: "pull_request",
        repository: "acme/web",
        actions: ["opened", "synchronize"],
        branches: ["main", "release/*"],
      },
    }
    const refused = await app.request(
      `/v1/agents/${loner.id}/triggers`,
      jsonAs(as(owner.email), { on, instruction: "Review it." }),
    )
    expect(refused.status).toBe(400)
    const added = await app.request(
      `/v1/agents/${reviewer.id}/triggers`,
      jsonAs(as(owner.email), { on, instruction: "Review this pull request." }),
    )
    expect(added.status).toBe(201)
    const trigger = (await added.json()) as {
      id: string
      kind: string
      on: unknown
      notice: string
    }
    expect(trigger).toMatchObject({ kind: "event", on })
    // Derive sets the webhook's secret itself and says what is left to turn on at GitHub.
    expect(hooks).toEqual([
      expect.objectContaining({
        url: "http://derive.test/v1/github/webhook",
        secret: githubWebhookSecret("1", KEY),
      }),
    ])
    expect(trigger.notice).toContain("https://github.com/settings/apps/derive-test/permissions")

    const pr = (over: { action?: string; base?: string; head?: string; draft?: boolean } = {}) => ({
      action: over.action ?? "opened",
      installation: { id: 44010 },
      repository: { full_name: "acme/web" },
      sender: { login: "dev" },
      pull_request: {
        number: 7,
        title: "Speed up search",
        html_url: "https://github.com/acme/web/pull/7",
        draft: over.draft ?? false,
        base: { ref: over.base ?? "main" },
        head: { sha: "a1b2c3d4e5f6", ref: "fast", repo: { full_name: over.head ?? "acme/web" } },
      },
    })
    const deliver = async (payload: object, delivery: string, event = "pull_request") => {
      const body = JSON.stringify(payload)
      const res = await app.request("/v1/github/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": event,
          "x-github-delivery": delivery,
          "x-hub-signature-256": githubWebhookSignature(body, githubWebhookSecret("1", KEY)),
        },
        body,
      })
      expect(res.status).toBe(202)
    }
    const jobs = () => meta.listJobs({ orgId: "default", triggerId: trigger.id })

    await deliver(pr(), "d-1")
    await deliver(pr(), "d-1") // GitHub redelivers: still one task
    const [job, ...rest] = await jobs()
    expect(rest).toEqual([])
    expect(job).toMatchObject({ agent_id: reviewer.id, trigger_id: trigger.id })
    expect(job?.instruction).toContain("Review this pull request.")
    expect(job?.instruction).toContain("GitHub pull_request.opened on acme/web#7: Speed up search")
    expect(JSON.parse(job?.meta_json ?? "{}")).toEqual({ repo: "acme/web@a1b2c3d4e5f6" })

    // Nothing else starts work: another action, another base, a fork, a draft, its own bot,
    // or an installation this agent does not hold.
    await deliver(pr({ action: "closed" }), "d-2")
    await deliver(pr({ base: "dev" }), "d-3")
    await deliver(pr({ head: "stranger/web" }), "d-4")
    await deliver(pr({ draft: true }), "d-5")
    await deliver({ ...pr(), sender: { login: "derive-test[bot]" } }, "d-6")
    await deliver({ ...pr(), installation: { id: 99 } }, "d-7")
    expect(await jobs()).toHaveLength(1)
    await deliver(pr({ action: "synchronize", base: "release/2.1" }), "d-8")
    expect(await jobs()).toHaveLength(2)
    // "merged" is a closed pull request that merged.
    await app.request(`/v1/triggers/${trigger.id}`, {
      ...jsonAs(as(owner.email), { on: { github: { ...on.github, actions: ["merged"] } } }),
      method: "PATCH",
    })
    await deliver(pr({ action: "closed" }), "d-10")
    expect(await jobs()).toHaveLength(2)
    const merged = pr({ action: "closed" })
    await deliver({ ...merged, pull_request: { ...merged.pull_request, merged: true } }, "d-11")
    expect(await jobs()).toHaveLength(3)

    // Paused, it waits; the schedule list never sees it.
    await app.request(`/v1/triggers/${trigger.id}`, {
      ...jsonAs(as(owner.email), { enabled: false }),
      method: "PATCH",
    })
    await deliver({ ...merged, pull_request: { ...merged.pull_request, merged: true } }, "d-9")
    expect(await jobs()).toHaveLength(3)
    expect(await meta.listEnabledScheduleTriggers(["default"])).toEqual([])
  })

  it("runs an agent's tasks in its repository when an ask names none", async () => {
    const { app, meta } = makeAuthedApp("gh-default-repo", [owner], "owner", {
      deps: { encryptionKey: KEY },
    })
    await seedApp(meta)
    const source = await upsertGithubConnection(meta, {
      orgId: "default",
      userId: owner.id,
      installationId: "44011",
      accountLogin: "acme",
    })
    const agent = (await (
      await app.request("/v1/agents", jsonAs(as(owner.email), { name: "Demo setup" }))
    ).json()) as { id: string }
    const patch = (body: object) =>
      app.request(`/v1/agents/${agent.id}`, { ...jsonAs(as(owner.email), body), method: "PATCH" })
    // Only through a GitHub source for that owner.
    expect((await patch({ repository: "acme/web" })).status).toBe(400)
    const saved = await patch({ connection_ids: [source.id], repository: "acme/web" })
    expect(saved.status).toBe(200)
    expect(await saved.json()).toMatchObject({ repository: "acme/web" })
    const ask = async (body: object) =>
      (await (
        await app.request(
          "/v1/jobs",
          jsonAs(as(owner.email), { agent_id: agent.id, instruction: "Set up a demo.", ...body }),
        )
      ).json()) as { id: string; task: { repo?: string } }
    expect((await ask({})).task).toEqual({ repo: "acme/web" })
    expect((await ask({ repo: "acme/api@main" })).task).toEqual({ repo: "acme/api@main" })
    // Cleared, tasks run without one.
    await patch({ repository: null })
    expect((await ask({})).task).toEqual({})
  })

  it("checks a task's repository out read-only when the App cannot write", async () => {
    const { app, meta } = makeAuthedApp("gh-read-only", [owner], "owner", {
      deps: { encryptionKey: KEY },
    })
    await seedApp(meta)
    const asked: string[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        if (/\/access_tokens$/.test(new URL(String(url)).pathname)) {
          const wants = (JSON.parse(String(init?.body)) as { permissions: { contents: string } })
            .permissions.contents
          asked.push(wants)
          if (wants === "write") return new Response("{}", { status: 422 })
          return new Response(
            JSON.stringify({ token: "read-token", expires_at: new Date(Date.now() + 3.6e6) }),
            { status: 201 },
          )
        }
        return new Response("not found", { status: 404 })
      }),
    )
    const source = await upsertGithubConnection(meta, {
      orgId: "default",
      userId: owner.id,
      installationId: "44012",
      accountLogin: "acme",
    })
    const agent = (await (
      await app.request(
        "/v1/agents",
        jsonAs(as(owner.email), {
          name: "Reader",
          connection_ids: [source.id],
          repository: "acme/web",
        }),
      )
    ).json()) as { id: string; token: string }
    await app.request(
      "/v1/jobs",
      jsonAs(as(owner.email), { agent_id: agent.id, instruction: "Look." }),
    )
    const pulled = (await (
      await app.request(`/v1/agents/${agent.id}/pull`, jsonAs(bearer(agent.token), {}))
    ).json()) as { jobs: { id: string; started_at: string }[] }
    const job = pulled.jobs[0]
    if (!job) throw new Error("nothing pulled")
    const git = await app.request(`/v1/jobs/${job.id}/git`, {
      headers: { ...bearer(agent.token), "x-derive-claim": job.started_at },
    })
    expect(await git.json()).toEqual({
      repo: "acme/web",
      ref: null,
      token: "read-token",
      read_only: true,
    })
    expect(asked).toEqual(["write", "read"])
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
        const repositoryAccess = repositoryAccessFixture(parsed.pathname)
        if (repositoryAccess) return repositoryAccess
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
                  ? { pull_requests: installationPullPermission, contents: "write" }
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
                contents: "write",
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
    expect(first.headers.get("location")).toContain("/settings/sources?github_connected=1")
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
        permissions: {
          actions: "write",
          contents: "write",
          metadata: "read",
          pull_requests: "write",
        },
      },
    ]
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const parsed = new URL(String(url))
        const repositoryAccess = repositoryAccessFixture(parsed.pathname)
        if (repositoryAccess) return repositoryAccess
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
        const repositoryAccess = repositoryAccessFixture(parsed.pathname)
        if (repositoryAccess) return repositoryAccess
        if (parsed.host === "github.com" && parsed.pathname === "/login/oauth/access_token")
          return new Response(JSON.stringify({ access_token: "ghu_existing" }), { status: 200 })
        if (parsed.pathname === "/user/installations")
          return new Response(JSON.stringify({ installations }), { status: 200 })
        if (parsed.pathname === "/app/installations/55002")
          return new Response(
            JSON.stringify({
              id: 55002,
              account: { login: "derive-two", type: "Organization" },
              permissions: {
                actions: "write",
                contents: "write",
                metadata: "read",
                pull_requests: "write",
              },
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
        const repositoryAccess = repositoryAccessFixture(parsed.pathname)
        if (repositoryAccess) return repositoryAccess
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
        const repositoryAccess = repositoryAccessFixture(parsed.pathname)
        if (repositoryAccess) return repositoryAccess
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
