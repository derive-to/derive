import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { MetaStore } from "@derive/core"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { FsBlobStore } from "@derive/storage/fs"
import Database from "better-sqlite3"
import { afterAll, describe, expect, it } from "vitest"
import { createApp } from "../src/app"
import { sha256 } from "../src/lib/crypto"
import { FakeBilling } from "./fake-billing"
import { as, jsonAs, makeAuthedApp, publishAs, type TestUser } from "./helpers"

const u = (n: number): TestUser => ({ id: `u${n}`, email: `u${n}@x.test`, name: `U${n}` })
const FOUR = [u(1), u(2), u(3), u(4)]
const THREE = [u(1), u(2), u(3)]
const PAST = "2000-01-01T00:00:00Z"

const seedSub = async (meta: MetaStore, status: string, orgId = "default") => {
  const now = new Date().toISOString()
  await meta.upsertSubscription({
    org_id: orgId,
    stripe_customer_id: "cus_1",
    stripe_subscription_id: "sub_1",
    tier: "team",
    billing_interval: "month",
    status,
    quantity: 4,
    current_period_end: null,
    created_at: now,
    updated_at: now,
  })
}

describe("billing gate", () => {
  it("beta: 4 editor seats publish freely", async () => {
    const { app } = makeAuthedApp("bg_beta", FOUR, "editor", {
      deps: { billing: new FakeBilling() },
    })
    const r = await publishAs(app, "hello", {}, as("u2@x.test"))
    expect(r.status).toBe(201)
  })

  it("enforced + 4 seats + no sub: publish 402 billing_required", async () => {
    const { app } = makeAuthedApp("bg_needs", FOUR, "editor", {
      deps: { billing: new FakeBilling(), billingEnforceAt: PAST },
    })
    const r = await publishAs(app, "hello", {}, as("u2@x.test"))
    expect(r.status).toBe(402)
    expect((await r.json()).code).toBe("billing_required")
  })

  it("enforced + 3 seats: publish stays open", async () => {
    const { app } = makeAuthedApp("bg_three", THREE, "editor", {
      deps: { billing: new FakeBilling(), billingEnforceAt: PAST },
    })
    expect((await publishAs(app, "hello", {}, as("u2@x.test"))).status).toBe(201)
  })

  it("enforced + active sub: 4 seats publish", async () => {
    const { app, meta } = makeAuthedApp("bg_active", FOUR, "editor", {
      deps: { billing: new FakeBilling(), billingEnforceAt: PAST },
    })
    await seedSub(meta, "active")
    expect((await publishAs(app, "hello", {}, as("u2@x.test"))).status).toBe(201)
  })

  it("enforced + canceled sub: read-only lapse, even at 3 seats", async () => {
    const { app, meta } = makeAuthedApp("bg_lapsed", THREE, "editor", {
      deps: { billing: new FakeBilling(), billingEnforceAt: PAST },
    })
    await seedSub(meta, "canceled")
    const r = await publishAs(app, "hello", {}, as("u2@x.test"))
    expect(r.status).toBe(402)
    expect((await r.json()).code).toBe("billing_lapsed")
  })

  it("lapse blocks review approve too, but reading stays open", async () => {
    const { app, meta } = makeAuthedApp("bg_lapse_read", THREE, "editor", {
      deps: { billing: new FakeBilling(), billingEnforceAt: PAST },
    })
    const pub = await publishAs(app, "hello", {}, as("u2@x.test"))
    expect(pub.status).toBe(201)
    const { short_id } = await pub.json()
    await seedSub(meta, "canceled")
    const approve = await app.request(
      `/v1/artifacts/${short_id}/review/approve`,
      jsonAs(as("u1@x.test"), {}),
    )
    expect(approve.status).toBe(402)
    const read = await app.request(`/v1/artifacts/${short_id}`, { headers: as("u2@x.test") })
    expect(read.status).toBe(200)
  })

  it("an active Team sub lifts a tiny fallback storage cap to the tier cap", async () => {
    const { app, meta } = makeAuthedApp("bg_cap", THREE, "editor", {
      deps: { billing: new FakeBilling(), maxBytes: 10 },
    })
    const blocked = await publishAs(app, "x".repeat(100), {}, as("u2@x.test"))
    expect(blocked.status).toBe(413)
    await seedSub(meta, "active")
    expect((await publishAs(app, "x".repeat(100), {}, as("u2@x.test"))).status).toBe(201)
  })

  // Three bypass paths found in review: each records a publish into a billing-blocked
  // workspace without ever consulting billingBlocked/BILLING_BLOCK_COPY. Seeded THREE
  // (never four) so the workspace is only ever lapsed by a canceled subscription, never
  // incidentally over the free seat limit — isolates the choke point under test.

  it("blocked workspace: version restore refuses with 402 billing_lapsed", async () => {
    const { app, meta } = makeAuthedApp("bg_restore", THREE, "editor", {
      deps: { billing: new FakeBilling(), billingEnforceAt: PAST },
    })
    const pub = await publishAs(app, "v1", {}, as("u1@x.test"))
    expect(pub.status).toBe(201)
    const { short_id } = await pub.json()
    expect((await publishAs(app, "v2", {}, as("u1@x.test"), short_id)).status).toBe(201)
    // Lapse AFTER the artifact + history exist, so only the restore itself is under test.
    await seedSub(meta, "canceled")
    const res = await app.request(
      `/v1/artifacts/${short_id}/restore`,
      jsonAs(as("u1@x.test"), { version: 1 }),
    )
    expect(res.status).toBe(402)
    expect((await res.json()).code).toBe("billing_lapsed")
  })

  it("blocked destination workspace: anonymous draft claim refuses with 402", async () => {
    const { app: drafts, meta } = makeAuthedApp("bg_claim", THREE, "editor", {
      deps: {
        subdomainBase: "bg-claim.test",
        encryptionKey: "0".repeat(64),
        billing: new FakeBilling(),
        billingEnforceAt: PAST,
      },
    })
    // Minting an anonymous draft is exempt (it lands in the system drafts org, not a
    // billed workspace) — only the CLAIM, which moves it into the caller's workspace,
    // should be gated. Lapse the destination before the claim so only the claim itself
    // (not the mint) is under test.
    await seedSub(meta, "canceled")
    const form = new FormData()
    form.append("file", new Blob([new TextEncoder().encode("<h1>hi</h1>")]), "page.html")
    const minted = await drafts.request("/v1/drafts", { method: "POST", body: form })
    expect(minted.status).toBe(201)
    const { claim_url } = await minted.json()
    const token = (claim_url as string).split("/claim/")[1]
    const res = await drafts.request("/v1/drafts/claim", {
      method: "POST",
      headers: { "content-type": "application/json", ...as("u1@x.test") },
      body: JSON.stringify({ token }),
    })
    expect(res.status).toBe(402)
    expect((await res.json()).code).toBe("billing_lapsed")
  })
})

// ---- MCP brand-profile scaffold ---------------------------------------------------
//
// resolveBrandprintProfileTarget (mcp-tools/publish.ts) scaffolds the Brandprint slot
// (a collection create + a placeholder publishVersion) the first time an Admin/Owner
// publishes to derive://brandprint/profile. That scaffold write runs BEFORE the tool's
// own billing gate (the review/propose split routes the profile's actual reveal to a
// free proposal, and the live-publish billing check sits strictly after that split) —
// so a billing-blocked workspace could still get the scaffold's live writes. Driven
// through the real /mcp JSON-RPC surface (not just the underlying function) because
// that IS the only route this scaffold is reachable through — there is no separate
// HTTP endpoint (the old setup_brandprint tool was folded into publish) — mirroring the
// harness test/mcp.test.ts already uses for this exact tool.
const mcpDir = mkdtempSync(join(tmpdir(), "derive-bg-mcp-"))
afterAll(() => rmSync(mcpDir, { recursive: true, force: true }))

function appWithGrant(
  name: string,
  scopes: string,
  extra: Partial<Parameters<typeof createApp>[0]> = {},
) {
  const path = join(mcpDir, `${name}.db`)
  const meta = new SqliteMetaStore(path)
  const db = new Database(path)
  db.exec(`
    CREATE TABLE IF NOT EXISTS "user" (id TEXT PRIMARY KEY, email TEXT, name TEXT, image TEXT, username TEXT, discoverable INTEGER, profession TEXT, about TEXT, brandprint TEXT);
    CREATE TABLE IF NOT EXISTS "oauthClient" (clientId TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE IF NOT EXISTS "oauthAccessToken" (token TEXT PRIMARY KEY, clientId TEXT, userId TEXT, scopes TEXT, expiresAt TEXT);
  `)
  db.prepare(
    `INSERT OR IGNORE INTO "user"(id,email,name) VALUES('u_o','owner@x.test','Owner')`,
  ).run()
  db.prepare(`INSERT OR IGNORE INTO "oauthClient"(clientId,name) VALUES('cli','Claude')`).run()
  db.prepare(
    `INSERT INTO "oauthAccessToken"(token,clientId,userId,scopes,expiresAt) VALUES(?,?,?,?,?)`,
  ).run(
    sha256(`tok_${name}`),
    "cli",
    "u_o",
    JSON.stringify(scopes.split(/\s+/).filter(Boolean)),
    new Date(Date.now() + 3_600_000).toISOString(),
  )
  db.close()
  const blobs = new FsBlobStore(join(mcpDir, `${name}-blobs`))
  const app = createApp({ meta, blobs, baseUrl: "http://derive.test", token: "tok", ...extra })
  return { app, token: `tok_${name}`, meta }
}

type McpApp = ReturnType<typeof createApp>

async function rpc(app: McpApp, token: string, body: unknown) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${token}`,
  }
  const res = await app.request("/mcp", { method: "POST", headers, body: JSON.stringify(body) })
  const ct = res.headers.get("content-type") ?? ""
  const txt = await res.text()
  let parsed: { result?: unknown; error?: unknown } | null = null
  if (ct.includes("application/json")) {
    parsed = JSON.parse(txt)
  } else if (ct.includes("text/event-stream")) {
    const dataLine = txt.split("\n").find((l) => l.startsWith("data:"))
    if (dataLine) parsed = JSON.parse(dataLine.slice(5).trim())
  }
  return { status: res.status, parsed }
}

const call = (app: McpApp, token: string, name: string, args: Record<string, unknown> = {}) =>
  rpc(app, token, {
    jsonrpc: "2.0",
    id: 9,
    method: "tools/call",
    params: { name, arguments: args },
  })

type RpcOut = Awaited<ReturnType<typeof rpc>>
const toolText = (r: RpcOut): string => {
  const t = (r.parsed?.result as { content?: { text: string }[] } | undefined)?.content?.[0]?.text
  if (t == null) throw new Error(`no tool text in response: ${JSON.stringify(r.parsed)}`)
  return t
}
const toolIsError = (r: RpcOut): boolean =>
  !!(r.parsed?.result as { isError?: boolean } | undefined)?.isError

describe("MCP brandprint scaffold billing gate", () => {
  it("blocked workspace: publishing derive://brandprint/profile refuses before scaffolding", async () => {
    const { app, token, meta } = appWithGrant(
      "bp-billing",
      "openid derive:read derive:publish derive:manage",
      { billing: new FakeBilling(), billingEnforceAt: PAST },
    )
    // Learn the grantor's default (personal) workspace, then lapse it — same
    // sequencing as the restore/claim tests above (block AFTER setup, isolating the
    // scaffold write itself).
    const ws = JSON.parse(toolText(await call(app, token, "list_workspaces")))
    const org = (ws.workspaces as { id: string; default: boolean }[]).find((w) => w.default)
      ?.id as string
    await seedSub(meta, "canceled", org)

    const out = await call(app, token, "publish", {
      short_id: "derive://brandprint/profile",
      content: "<h1>Derive brand profile</h1>",
    })
    expect(toolIsError(out)).toBe(true)
    expect(toolText(out)).toContain("plan has lapsed")

    // No scaffold write happened: no brandprint pointer persisted, no collection made.
    const settings = await meta.getOrgSettings(org)
    expect(settings.brandprint?.profileId).toBeFalsy()
  })
})
