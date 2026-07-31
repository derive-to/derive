import { describe, expect, it } from "vitest"
import { as, jsonAs, makeAuthedApp, type TestUser } from "./helpers"

/**
 * The sign-in flow against authorization servers that actually exist.
 *
 * OFF BY DEFAULT — `LIVE_MCP=1 npx vitest run test/live-oauth.test.ts`. These make real requests
 * to third parties, including a real dynamic client registration.
 *
 * HOW FAR THIS GOES, precisely: everything up to the consent screen. It creates the connection,
 * discovers the authorization server, registers Derive as a client for real, and produces the URL
 * a person would be sent to. It does NOT grant consent — that needs a human with an account at
 * the far end, and no test can honestly claim it. The callback half is covered against a stub in
 * mcp-oauth.test.ts.
 *
 * That boundary is the point of the file. "Discovery works" is the half that silently breaks per
 * vendor (different origins, path-aware metadata, registration policies), and it is the half that
 * a stub written from the spec will always agree with.
 */

const live = process.env.LIVE_MCP === "1"

/** Vendors whose MCP servers are live and offer dynamic registration to anyone who asks. */
const VENDORS = [
  { name: "Linear", url: "https://mcp.linear.app/mcp", authHost: "linear.app" },
  { name: "Sentry", url: "https://mcp.sentry.dev/mcp", authHost: "sentry.dev" },
]

describe.skipIf(!live)("starting a sign-in against a live authorization server", () => {
  for (const vendor of VENDORS) {
    it(`${vendor.name}: connect parks it, then authorize returns a real consent URL`, async () => {
      const me: TestUser = { id: "u_live", email: "live@derive.test", name: "L" }
      const { app } = makeAuthedApp(`live-oauth-${vendor.name}`, [me], "editor", {
        deps: {
          encryptionKey: "live-oauth-test-secret-at-least-16",
          baseUrl: "https://derive.test",
        },
      })

      const created = await app.request(
        "/v1/connections",
        jsonAs(as(me.email), { toolkit: vendor.name.toLowerCase(), mcp_url: vendor.url }),
      )
      const body = (await created.json()) as { id: string; status: string; reason?: string }
      expect(created.status).toBe(201)
      expect(body.status).toBe("pending")
      expect(body.reason).toBe("auth_required")

      const res = await app.request(`/v1/connections/${body.id}/authorize`, {
        method: "POST",
        headers: as(me.email),
      })
      const text = await res.text()
      expect(res.status, `authorize failed: ${text}`).toBe(200)
      const url = new URL((JSON.parse(text) as { authorize_url: string }).authorize_url)

      // A real consent page at the real vendor, not something we assembled from a guess.
      expect(url.hostname.endsWith(vendor.authHost)).toBe(true)
      expect(url.searchParams.get("response_type")).toBe("code")
      expect(url.searchParams.get("code_challenge_method")).toBe("S256")
      expect(url.searchParams.get("code_challenge")).toBeTruthy()
      expect(url.searchParams.get("client_id"), "registration produced no client").toBeTruthy()
      expect(url.searchParams.get("redirect_uri")).toBe(
        "https://derive.test/v1/connections/oauth/callback",
      )
      expect(url.searchParams.get("state"), "our signed state").toBeTruthy()

      // The consent page has to actually be there. A 404 here means the flow dead-ends at the one
      // step we hand a human, which is exactly the failure a green discovery test would hide.
      const page = await fetch(url.toString(), { redirect: "manual" })
      expect([200, 302, 303, 307].includes(page.status), `consent page: ${page.status}`).toBe(true)
    }, 60_000)
  }
})
