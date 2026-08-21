import type { MetaStore } from "@derive/core"
import { describe, expect, it } from "vitest"
import { makeOauthAgent } from "../src/lib/oauth-agent"

// The scope-derived role is a PROPOSAL; the granting user's actual membership in
// the resolved workspace is the ceiling. Without the cap, a publish-scoped grant
// bound (or re-homed) to a workspace where its user is only a viewer would act
// as editor there. Unit-level against a stub store: the resolution logic is pure
// dispatch over meta, so no app or database is needed.
describe("oauth agent role capping + consent binding", () => {
  const grant = {
    userId: "u1",
    userEmail: "u@x.test",
    userName: "U",
    clientId: "cli",
    clientName: "Claude",
    scopes: ["openid", "derive:read", "derive:publish"],
    expiresAt: new Date(Date.now() + 60_000),
  }
  // workspacesAndOauthBinding is derived from the (possibly overridden) listWorkspaces /
  // getOAuthClientWorkspaces below, not hardcoded — so a test overriding either of those
  // still flows through, exactly as it did before the two calls collapsed into one.
  const stub = (over: Record<string, unknown> = {}): MetaStore => {
    const merged = {
      getOAuthGrant: async () => grant,
      listWorkspaces: async () => [
        { id: "ws_one", name: "One", role: "owner" },
        { id: "ws_two", name: "Two", role: "viewer" },
      ],
      getOAuthClientWorkspaces: async () => [],
      ...over,
    } as unknown as MetaStore
    return {
      ...merged,
      workspacesAndOauthBinding: async (userId: string, clientId: string) => ({
        mine: await merged.listWorkspaces(userId),
        bound: await merged.getOAuthClientWorkspaces(userId, clientId),
      }),
    } as unknown as MetaStore
  }

  const resolve = (meta: MetaStore) =>
    makeOauthAgent({
      meta,
      auth: undefined,
      baseUrl: "http://derive.test",
      audiences: ["http://derive.test"],
      provisionPersonal: async () => "ws_personal",
    }).oauthAgent("tok")

  it("keeps the scope role where the membership allows it", async () => {
    const o = await resolve(stub())
    expect(o?.rec.org_id).toBe("ws_one")
    expect(o?.rec.role).toBe("editor") // publish scope, owner membership → editor
    expect(o?.scopeRole).toBe("editor")
  })

  it("caps the scope role by the membership in the scoped workspace", async () => {
    const o = await resolve(stub({ getOAuthClientWorkspaces: async () => ["ws_two"] }))
    expect(o?.rec.org_id).toBe("ws_two")
    expect(o?.rec.role).toBe("viewer") // publish scope, viewer membership → viewer
    expect(o?.scopeRole).toBe("editor") // uncapped, for header re-homes to re-cap
  })

  it("derive:manage maps to owner — and the membership ceiling still holds", async () => {
    const manage = { ...grant, scopes: ["openid", "derive:read", "derive:manage"] }
    const asOwner = await resolve(stub({ getOAuthGrant: async () => manage }))
    expect(asOwner?.scopeRole).toBe("owner")
    expect(asOwner?.rec.role).toBe("owner") // owner membership → the scope holds
    const asViewer = await resolve(
      stub({ getOAuthGrant: async () => manage, getOAuthClientWorkspaces: async () => ["ws_two"] }),
    )
    expect(asViewer?.rec.role).toBe("viewer") // manage scope can't outrank the human
  })

  it("ignores a scope naming a workspace the user is no longer in", async () => {
    const o = await resolve(stub({ getOAuthClientWorkspaces: async () => ["ws_gone"] }))
    expect(o?.rec.org_id).toBe("ws_one")
    expect(o?.rec.role).toBe("editor")
  })

  it("provisions a personal workspace (as owner) when the user has none", async () => {
    const o = await resolve(stub({ listWorkspaces: async () => [] }))
    expect(o?.rec.org_id).toBe("ws_personal")
    expect(o?.rec.role).toBe("editor")
  })
})
