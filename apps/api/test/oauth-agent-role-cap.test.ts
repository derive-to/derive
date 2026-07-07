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
  const stub = (over: Record<string, unknown> = {}): MetaStore =>
    ({
      getOAuthGrant: async () => grant,
      listWorkspaces: async () => [
        { id: "ws_one", name: "One", role: "owner" },
        { id: "ws_two", name: "Two", role: "viewer" },
      ],
      getOAuthClientWorkspace: async () => null,
      ...over,
    }) as unknown as MetaStore

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

  it("caps the scope role by the membership in the bound workspace", async () => {
    const o = await resolve(stub({ getOAuthClientWorkspace: async () => "ws_two" }))
    expect(o?.rec.org_id).toBe("ws_two")
    expect(o?.rec.role).toBe("viewer") // publish scope, viewer membership → viewer
    expect(o?.scopeRole).toBe("editor") // uncapped, for header re-homes to re-cap
  })

  it("ignores a binding to a workspace the user is no longer in", async () => {
    const o = await resolve(stub({ getOAuthClientWorkspace: async () => "ws_gone" }))
    expect(o?.rec.org_id).toBe("ws_one")
    expect(o?.rec.role).toBe("editor")
  })

  it("provisions a personal workspace (as owner) when the user has none", async () => {
    const o = await resolve(stub({ listWorkspaces: async () => [] }))
    expect(o?.rec.org_id).toBe("ws_personal")
    expect(o?.rec.role).toBe("editor")
  })
})
