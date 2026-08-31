import { createVerify, generateKeyPairSync } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import { appJwt, installationToken } from "../src/lib/github-app"
import { as, makeAuthedApp, type TestUser } from "./helpers"

// A throwaway RSA keypair, PKCS#1 PEM — the exact format GitHub's manifest
// conversion hands back, so this also proves createPrivateKey accepts it.
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
})

const decode = (seg: string) => JSON.parse(Buffer.from(seg, "base64url").toString("utf8"))

afterEach(() => vi.unstubAllGlobals())

describe("GitHub App registration", () => {
  const operator: TestUser = {
    id: "u_github_app_operator",
    email: "github-operator@derive.test",
    name: "Operator",
  }
  const secondOperator: TestUser = {
    id: "u_github_app_operator_two",
    email: "github-operator-two@derive.test",
    name: "Second operator",
  }

  it("keeps instance App setup away from ordinary workspace owners", async () => {
    const { app } = makeAuthedApp("github-app-operator-gate", [operator], "editor", {
      deps: { encryptionKey: "github-app-registration-key" },
    })
    const res = await app.request("/settings/github/app/new", {
      headers: as(operator.email),
    })
    expect(res.status).toBe(403)
    expect(await res.text()).toContain("Only an instance operator")
  })

  it("asks the operator who should own the App instead of defaulting to their account", async () => {
    const { app } = makeAuthedApp("github-app-owner-choice", [operator], "editor", {
      deps: { encryptionKey: "github-app-registration-key" },
      operatorIds: [operator.id],
    })
    const res = await app.request("/settings/github/app/new", {
      headers: as(operator.email),
    })
    const html = await res.text()
    expect(res.status).toBe(200)
    expect(html).toContain("GitHub organization")
    expect(html).toContain("GitHub shows that account as the App developer")
    expect(html).toContain("https://github.com/organizations/")
    expect(html).toContain("Use personal account")
    expect(html).not.toContain("setTimeout")
  })

  it("binds conversion to the initiating operator and never replaces the shared App", async () => {
    const { app, meta } = makeAuthedApp(
      "github-app-insert-only",
      [operator, secondOperator],
      "owner",
      {
        deps: { encryptionKey: "github-app-registration-key" },
        operatorIds: [operator.id, secondOperator.id],
      },
    )
    const setup = await app.request("/settings/github/app/new", {
      headers: as(operator.email),
    })
    const html = await setup.text()
    const state = html.match(/settings\/apps\/new\?state=([A-Za-z0-9_.-]+)/)?.[1]
    expect(state).toBeTruthy()

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              id: 991,
              slug: "derive-owned",
              client_id: "Iv1.owned",
              client_secret: "secret",
              pem: privateKey,
            }),
            { status: 201 },
          ),
      ),
    )
    const wrongUser = await app.request(
      `/settings/github/app/created?code=wrong&state=${encodeURIComponent(state ?? "")}`,
      { headers: as(secondOperator.email) },
    )
    expect(wrongUser.status).toBe(400)
    expect(await meta.getGithubApp()).toBeNull()

    const created = await app.request(
      `/settings/github/app/created?code=right&state=${encodeURIComponent(state ?? "")}`,
      { headers: as(operator.email) },
    )
    expect(created.status).toBe(200)
    expect(await meta.getGithubApp()).toMatchObject({ app_id: "991", slug: "derive-owned" })

    const replay = await app.request(
      `/settings/github/app/created?code=replay&state=${encodeURIComponent(state ?? "")}`,
      { headers: as(operator.email) },
    )
    expect(replay.status).toBe(409)
    expect(await meta.getGithubApp()).toMatchObject({ app_id: "991", slug: "derive-owned" })
  })
})

describe("appJwt", () => {
  it("signs a verifiable RS256 JWT with the App id as issuer", () => {
    const jwt = appJwt("12345", privateKey, 1_000_000)
    const [header, payload, sig] = jwt.split(".")
    expect(decode(header as string)).toEqual({ alg: "RS256", typ: "JWT" })
    expect(decode(payload as string)).toEqual({
      iat: 1_000_000 - 60,
      exp: 1_000_000 + 540,
      iss: "12345",
    })
    const ok = createVerify("RSA-SHA256")
      .update(`${header}.${payload}`)
      .verify(publicKey, Buffer.from(sig as string, "base64url"))
    expect(ok).toBe(true)
  })
})

describe("installationToken", () => {
  it("keeps permission profiles and repository scopes isolated in the token cache", async () => {
    const calls: RequestInit[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        calls.push(init ?? {})
        return new Response(
          JSON.stringify({
            token: `installation-profile-${calls.length}`,
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          }),
          { status: 201 },
        )
      }),
    )

    const narrow = await installationToken("12345", privateKey, "9001")
    const narrowAgain = await installationToken("12345", privateKey, "9001")
    const comment = await installationToken("12345", privateKey, "9001", "pr-comment")
    const commentAgain = await installationToken("12345", privateKey, "9001", "pr-comment")
    const read = await installationToken("12345", privateKey, "9001", "workflow-read", "derive")
    const readAgain = await installationToken(
      "12345",
      privateKey,
      "9001",
      "workflow-read",
      "derive",
    )
    const actions = await installationToken(
      "12345",
      privateKey,
      "9001",
      "workflow-dispatch",
      "derive",
    )
    const actionsAgain = await installationToken(
      "12345",
      privateKey,
      "9001",
      "workflow-dispatch",
      "derive",
    )

    expect(narrow).toBe("installation-profile-1")
    expect(narrowAgain).toBe(narrow)
    expect(comment).toBe("installation-profile-2")
    expect(commentAgain).toBe(comment)
    expect(read).toBe("installation-profile-3")
    expect(readAgain).toBe(read)
    expect(actions).toBe("installation-profile-4")
    expect(actionsAgain).toBe(actions)
    expect(calls).toHaveLength(4)
    expect(JSON.parse(String(calls[0]?.body))).toEqual({
      permissions: { metadata: "read", pull_requests: "read" },
    })
    expect(JSON.parse(String(calls[1]?.body))).toEqual({
      permissions: { metadata: "read", pull_requests: "write" },
    })
    expect(JSON.parse(String(calls[2]?.body))).toEqual({
      permissions: { actions: "read", metadata: "read" },
      repositories: ["derive"],
    })
    expect(JSON.parse(String(calls[3]?.body))).toEqual({
      permissions: { actions: "write", metadata: "read" },
      repositories: ["derive"],
    })
    expect(new Headers(calls[0]?.headers).get("content-type")).toBe("application/json")
  })

  it("refuses malformed installation and repository scopes before calling GitHub", async () => {
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    await expect(installationToken("12345", privateKey, "not-an-id")).rejects.toThrow(
      /installation id/i,
    )
    await expect(installationToken("12345", privateKey, "9002", "workflow-read")).rejects.toThrow(
      /name one repository/i,
    )
    await expect(
      installationToken("12345", privateKey, "9002", "workflow-read", "bad/repo"),
    ).rejects.toThrow(/repository name/i)
    expect(fetch).not.toHaveBeenCalled()
  })

  it("uses a server-owned API base for GitHub Enterprise and local integration tests", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            token: "enterprise-installation-token",
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          }),
          { status: 201 },
        ),
    )
    vi.stubGlobal("fetch", fetch)
    const token = await installationToken(
      "12345",
      privateKey,
      "9011",
      "workflow-dispatch",
      "sift",
      "https://github.example/api/v3/",
    )
    expect(token).toBe("enterprise-installation-token")
    expect(fetch).toHaveBeenCalledWith(
      "https://github.example/api/v3/app/installations/9011/access_tokens",
      expect.any(Object),
    )
  })
})
