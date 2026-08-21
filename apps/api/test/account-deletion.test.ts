import { randomUUID as uuid } from "node:crypto"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { describe, expect, it } from "vitest"
import { workspacesBlockingDeletion } from "../src/lib/account"

// The ownership guard behind account deletion: purging an account removes its workspace,
// artifact, and collection owner rows directly, so every one of those authorities needs a
// live handoff first. Personal-workspace artifacts survive account deletion, so they count too.
describe("workspacesBlockingDeletion", () => {
  const store = () => new SqliteMetaStore(":memory:")

  it("allows deletion when the user only owns an empty personal workspace", async () => {
    const s = store()
    const me = `u_${uuid()}`
    await s.setWorkspace(`ws_p_${me}`, "Mine")
    await s.setMembership({ id: uuid(), org_id: `ws_p_${me}`, user_id: me, role: "owner" })
    expect(await workspacesBlockingDeletion(s, me)).toEqual([])
  })

  it("blocks when account purge would orphan a personal-workspace artifact", async () => {
    const s = store()
    const me = `u_${uuid()}`
    const personal = `ws_p_${me}`
    await s.setWorkspace(personal, "Mine")
    await s.setMembership({ id: uuid(), org_id: personal, user_id: me, role: "owner" })
    const artifact = await s.createArtifact({
      id: uuid(),
      short_id: uuid().slice(0, 8),
      org_id: personal,
      slug: null,
      title: "Private draft",
      workspace_access: "none",
      link_role: "none",
      listed: "none",
      kind: "file",
      spa: 0,
    })
    await s.setArtifactMember({
      id: uuid(),
      artifact_id: artifact.id,
      user_id: me,
      role: "owner",
    })

    expect(await workspacesBlockingDeletion(s, me)).toEqual(["Mine"])

    await s.deleteArtifact(artifact.id, personal)
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

  it("blocks when account purge would orphan owned artifacts or collections", async () => {
    const s = store()
    const me = `u_${uuid()}`
    const admin = `u_${uuid()}`
    await s.setWorkspace("shared", "Team Space")
    await s.setMembership({ id: uuid(), org_id: "shared", user_id: admin, role: "owner" })
    await s.setMembership({ id: uuid(), org_id: "shared", user_id: me, role: "editor" })
    const artifact = await s.createArtifact({
      id: uuid(),
      short_id: uuid().slice(0, 8),
      org_id: "shared",
      slug: null,
      title: "Private draft",
      workspace_access: "none",
      link_role: "none",
      listed: "none",
      kind: "file",
      spa: 0,
    })
    await s.setArtifactMember({
      id: uuid(),
      artifact_id: artifact.id,
      user_id: me,
      role: "owner",
    })
    const collection = await s.createCollection({
      id: uuid(),
      org_id: "shared",
      title: "Private collection",
      created_by: me,
      workspace_access: "none",
    })
    await s.setCollectionMember({
      id: uuid(),
      collection_id: collection.id,
      user_id: me,
      role: "owner",
    })

    expect(await workspacesBlockingDeletion(s, me)).toEqual(["Team Space"])

    await s.setArtifactMember({
      id: uuid(),
      artifact_id: artifact.id,
      user_id: admin,
      role: "owner",
    })
    await s.setCollectionMember({
      id: uuid(),
      collection_id: collection.id,
      user_id: admin,
      role: "owner",
    })
    expect(await workspacesBlockingDeletion(s, me)).toEqual([])
  })
})
