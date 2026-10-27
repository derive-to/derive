import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { FsBlobStore } from "@derive/storage/fs"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import Database from "better-sqlite3"
import { drizzle } from "drizzle-orm/better-sqlite3"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createApp } from "../src/app"
import { makeAuth, migrateAuth, resolvePasskey } from "../src/auth-config"
import { authSchema } from "../src/auth-schema"

// makeAuth wires optional identity providers off env: Google when its client
// id/secret are set, and an enterprise OIDC provider (Okta/Entra/…) via the
// generic-OAuth plugin when OIDC_* is set. These cover the provider branches that
// the same-origin test (which runs with neither set) leaves cold.
const PROVIDER_ENV = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "OIDC_ISSUER",
  "OIDC_CLIENT_ID",
  "OIDC_CLIENT_SECRET",
  "OIDC_PROVIDER_ID",
  "DERIVE_CROSS_SITE",
] as const

const saved = Object.fromEntries(PROVIDER_ENV.map((k) => [k, process.env[k]]))
const db = () => new Database(":memory:")

afterEach(() => {
  for (const k of PROVIDER_ENV) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe("auth-config: optional providers", () => {
  it("does not enable Google when only one of the pair is set", () => {
    process.env.GOOGLE_CLIENT_ID = "gid" // no secret
    const auth = makeAuth(db(), "http://derive.test", "test-secret-0123456789abcd")
    expect(auth.options.socialProviders?.google).toBeUndefined()
  })

  it("applies SameSite=None;Secure cookies when DERIVE_CROSS_SITE=true", () => {
    process.env.DERIVE_CROSS_SITE = "true"
    const auth = makeAuth(db(), "http://derive.test", "test-secret-0123456789abcd")
    expect(auth.options.advanced?.defaultCookieAttributes).toMatchObject({
      sameSite: "none",
      secure: true,
    })
  })
})

describe("auth-config: enterprise SSO callback", () => {
  // Better Auth 1.7 moved the generic-OAuth callback from /api/auth/oauth2/callback/:id to
  // /api/auth/callback/:id. Every IdP an operator configured names the old path, so an upgrade
  // must keep sending it and keep answering on it.
  it("keeps the 1.6 redirect URI, and that path still reaches the callback handler", async () => {
    process.env.OIDC_ISSUER = "https://idp.example"
    process.env.OIDC_CLIENT_ID = "cid"
    process.env.OIDC_CLIENT_SECRET = "csecret"
    const discovery = {
      issuer: "https://idp.example",
      authorization_endpoint: "https://idp.example/authorize",
      token_endpoint: "https://idp.example/token",
      jwks_uri: "https://idp.example/jwks",
      response_types_supported: ["code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
    }
    const realFetch = globalThis.fetch
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) =>
        String(input instanceof Request ? input.url : input).startsWith("https://idp.example/")
          ? Response.json(discovery)
          : realFetch(input, init),
      )
    try {
      const BASE = "http://localhost:8080"
      const tmp = mkdtempSync(join(tmpdir(), "derive-sso-"))
      const auth = makeAuth(new Database(join(tmp, "a.db")), BASE, "test-secret-0123456789abcd")
      await migrateAuth(auth)
      const app = createApp({
        meta: new SqliteMetaStore(join(tmp, "a.db")),
        blobs: new FsBlobStore(join(tmp, "blobs")),
        baseUrl: BASE,
        auth,
      })
      const start = await app.request(
        new Request(`${BASE}/api/auth/sign-in/social`, {
          method: "POST",
          headers: { origin: BASE, "content-type": "application/json" },
          body: JSON.stringify({ provider: "sso", callbackURL: "/" }),
        }),
      )
      const url = new URL(((await start.json()) as { url: string }).url)
      expect(url.searchParams.get("redirect_uri")).toBe(`${BASE}/api/auth/oauth2/callback/sso`)

      // The IdP returns to the old path; the callback handler consumes the state there.
      const cookie = start.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; ")
      const back = await app.request(
        new Request(
          `${BASE}/api/auth/oauth2/callback/sso?error=access_denied&state=${url.searchParams.get("state")}`,
          { headers: { cookie }, redirect: "manual" },
        ),
      )
      expect(back.status).toBe(302)
      expect(back.headers.get("location")).toContain("error=access_denied")
    } finally {
      fetchSpy.mockRestore()
    }
  })
})

describe("auth-config: the edge (D1) auth schema", () => {
  // The Worker's D1 path hands Better Auth a hand-written Drizzle schema (auth-schema.ts).
  // Better Auth 1.7 checks that schema against the config before serving any auth request
  // and fails every one of them on a missing table or column, so a field or plugin added to
  // makeAuth without a matching auth-schema.ts entry takes D1 sign-in down entirely.
  it("matches what makeAuth needs: sign-up and agent registration work through Drizzle", async () => {
    const BASE = "http://localhost:8787"
    const raw = new Database(":memory:")
    await migrateAuth(makeAuth(raw, BASE, "test-secret-0123456789abcd"))
    const auth = makeAuth(
      drizzleAdapter(drizzle(raw, { schema: authSchema }), {
        provider: "sqlite",
        schema: authSchema,
      }),
      BASE,
      "test-secret-0123456789abcd",
    )
    const post = (path: string, body: unknown) =>
      auth.handler(
        new Request(`${BASE}/api/auth${path}`, {
          method: "POST",
          headers: { origin: BASE, "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      )
    expect(
      (
        await post("/sign-up/email", {
          email: "d1@derive.test",
          password: "correct-horse-9",
          name: "D",
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await post("/oauth2/register", {
          client_name: "Agent",
          redirect_uris: ["http://localhost:53682/callback"],
          token_endpoint_auth_method: "none",
        })
      ).status,
    ).toBe(201)
  })
})

describe("resolvePasskey — WebAuthn rpID/origin resolution", () => {
  afterEach(() => {
    delete process.env.DERIVE_PASSKEY_RPID
  })

  it("enables passkeys for a single-origin self-host (rpID derived, one allowed origin)", () => {
    const r = resolvePasskey({
      baseUrl: "https://derive.example",
      webOrigins: [],
    })
    expect(r.enabled).toBe(true)
    expect(r.rpID).toBeUndefined() // let SimpleWebAuthn derive it from the origin
    expect(r.origin).toEqual(["https://derive.example"])
  })

  it("treats a different-PORT web origin (localhost dev) as same-origin (rpID=localhost)", () => {
    const r = resolvePasskey({
      baseUrl: "http://localhost:8787",
      webOrigins: ["http://localhost:3090"],
    })
    expect(r.enabled).toBe(true)
    expect(r.rpID).toBeUndefined()
    expect(r.origin).toEqual(["http://localhost:8787", "http://localhost:3090"])
  })

  it("pins rpID to the shared registrable parent on a cross-site split, allowing both origins", () => {
    const r = resolvePasskey({
      baseUrl: "https://api.derive.to",
      webOrigins: ["https://app.derive.to"],
    })
    expect(r.enabled).toBe(true)
    expect(r.rpID).toBe("derive.to")
    expect(r.origin).toEqual(["https://api.derive.to", "https://app.derive.to"])
  })

  it("disables passkeys when SPA + API span two different registrable domains", () => {
    const r = resolvePasskey({
      baseUrl: "https://api.derive.to",
      webOrigins: ["https://app.example.com"],
    })
    expect(r.enabled).toBe(false)
  })

  it("honours an explicit DERIVE_PASSKEY_RPID override", () => {
    process.env.DERIVE_PASSKEY_RPID = "derive.io"
    const r = resolvePasskey({
      baseUrl: "https://api.derive.io",
      webOrigins: ["https://app.derive.io"],
    })
    expect(r.enabled).toBe(true)
    expect(r.rpID).toBe("derive.io")
  })
})
