import { describe, expect, it } from "vitest"
import { as, bearer, jsonAs, makeAuthedApp, type TestUser } from "./helpers"

// Workspace plans: a broker key (the tool broker reads it) and a monthly limit (the chat budget
// reads it). Personal, or the workspace pool with manage. Secrets are encrypted at rest, never
// surfaced, and revocable here.
const KEY = "test-encryption-key"

describe("plans (bring-your-own model + broker)", () => {
  const owner: TestUser = { id: "u_plan_own", email: "planown@derive.test", name: "Owner" }
  const member: TestUser = { id: "u_plan_mem", email: "planmem@derive.test", name: "Member" }
  const { app } = makeAuthedApp("plans", [owner, member], "commenter", {
    deps: { encryptionKey: KEY },
  })
  const attach = (who: string, body: object) => app.request("/v1/plans", jsonAs(as(who), body))

  it("attaches a personal model plan; the secret is never surfaced", async () => {
    const res = await attach(owner.email, {
      kind: "model",
      provider: "anthropic",
      secret: "sk-ant-SECRET",
    })
    expect(res.status).toBe(201)
    const p = (await res.json()) as Record<string, unknown>
    expect(p).toMatchObject({
      kind: "model",
      provider: "anthropic",
      scope: "personal",
      user_id: owner.id,
    })
    expect(p.secret).toBeUndefined()
    expect(p.secret_enc).toBeUndefined()
    // Listed, still no secret anywhere in the payload.
    const listed = await (await app.request("/v1/plans", { headers: as(owner.email) })).json()
    expect(JSON.stringify(listed)).not.toContain("sk-ant-SECRET")
    expect(listed.plans.some((x: { id: string }) => x.id === p.id)).toBe(true)
  })

  it("a workspace pool plan needs manage; a commenter-seat member can't", async () => {
    const denied = await attach(member.email, {
      kind: "model",
      provider: "anthropic",
      secret: "sk",
      scope: "workspace",
    })
    expect([403, 404]).toContain(denied.status)
    const ok = await attach(owner.email, {
      kind: "model",
      provider: "anthropic",
      secret: "sk",
      scope: "workspace",
    })
    expect(ok.status).toBe(201)
    expect((await ok.json()).scope).toBe("workspace")
  })

  it("owner removes their own personal plan", async () => {
    const p = await (
      await attach(owner.email, { kind: "broker", provider: "composio", secret: "ck" })
    ).json()
    const del = await app.request(`/v1/plans/${p.id}`, {
      method: "DELETE",
      headers: as(owner.email),
    })
    expect(del.status).toBe(204)
  })
})
