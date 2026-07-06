import { randomUUID as uuid } from "node:crypto"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { describe, expect, it } from "vitest"
import { workspacesBlockingDeletion } from "../src/lib/account"

// The sole-owner guard behind account deletion: a user may not delete their account while
// they're the LAST owner of a workspace that still has other members (it would strand that
// workspace with no admin). A solo/personal workspace, or one with a co-owner, is fine.
describe("workspacesBlockingDeletion", () => {
  const store = () => new SqliteMetaStore(":memory:")

  it("allows deletion when the user only owns solo/personal workspaces", async () => {
    const s = store()
    const me = `u_${uuid()}`
    await s.setWorkspace(`ws_p_${me}`, "Mine")
    await s.setMembership({ id: uuid(), org_id: `ws_p_${me}`, user_id: me, role: "owner" })
    expect(await workspacesBlockingDeletion(s, me)).toEqual([])
  })

  it("BLOCKS deletion when the user is the sole owner of a shared workspace", async () => {
    const s = store()
    const me = `u_${uuid()}`
    const other = `u_${uuid()}`
    await s.setWorkspace("shared", "Team Space")
    await s.setMembership({ id: uuid(), org_id: "shared", user_id: me, role: "owner" })
    await s.setMembership({ id: uuid(), org_id: "shared", user_id: other, role: "editor" })
    expect(await workspacesBlockingDeletion(s, me)).toEqual(["Team Space"])
  })

  it("allows deletion when a shared workspace has a co-owner (not the last admin)", async () => {
    const s = store()
    const me = `u_${uuid()}`
    const coOwner = `u_${uuid()}`
    await s.setWorkspace("shared", "Team Space")
    await s.setMembership({ id: uuid(), org_id: "shared", user_id: me, role: "owner" })
    await s.setMembership({ id: uuid(), org_id: "shared", user_id: coOwner, role: "owner" })
    expect(await workspacesBlockingDeletion(s, me)).toEqual([])
  })

  it("ignores workspaces where the user is only a member, not an owner", async () => {
    const s = store()
    const me = `u_${uuid()}`
    const owner = `u_${uuid()}`
    await s.setWorkspace("shared", "Team Space")
    await s.setMembership({ id: uuid(), org_id: "shared", user_id: owner, role: "owner" })
    await s.setMembership({ id: uuid(), org_id: "shared", user_id: me, role: "editor" })
    expect(await workspacesBlockingDeletion(s, me)).toEqual([])
  })
})
