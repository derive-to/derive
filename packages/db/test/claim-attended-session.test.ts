import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { SqliteMetaStore } from "../src/sqlite"

// claimAttendedSession is a MUTUAL EXCLUSION primitive, so the only test that means anything
// is a contended one. It was added on the reasoning that two tabs (or a retry after a client
// timeout) must not both run a turn — asserting that without contending for it would be
// asserting the comment, not the code.

const store = () => {
  const dir = mkdtempSync(join(tmpdir(), "claim-"))
  return new SqliteMetaStore(join(dir, "db.sqlite"))
}

const openSession = async (m: SqliteMetaStore, id: string) =>
  m.createSession({
    id,
    context_id: null,
    context_version: null,
    org_id: "default",
    asker_id: "u-ed",
    subject_ref: JSON.stringify({ kind: "artifact", id: "doc1" }),
  })

const inAWhile = () => new Date(Date.now() + 60_000).toISOString()

describe("claimAttendedSession", () => {
  it("lets exactly ONE of many concurrent callers win", async () => {
    const m = store()
    await openSession(m, "ses_race")
    // Ten callers, launched together — the shape of two tabs hitting send at once.
    const results = await Promise.all(
      Array.from({ length: 10 }, () => m.claimAttendedSession("ses_race", inAWhile())),
    )
    expect(results.filter(Boolean)).toHaveLength(1)
  })

  it("does not re-claim a session whose lease is still live", async () => {
    const m = store()
    await openSession(m, "ses_held")
    expect(await m.claimAttendedSession("ses_held", inAWhile())).not.toBeNull()
    // A second turn arriving while the first is still working must find nothing.
    expect(await m.claimAttendedSession("ses_held", inAWhile())).toBeNull()
  })

  it("RECLAIMS after the lease lapses, so a crashed turn cannot strand the session", async () => {
    // The other half of why the claim exists: without a lease, a process that died mid-turn
    // left the session `open` forever and the UI polled on it indefinitely.
    const m = store()
    await openSession(m, "ses_dead")
    const lapsed = new Date(Date.now() - 1000).toISOString()
    expect(await m.claimAttendedSession("ses_dead", lapsed)).not.toBeNull()
    expect(await m.claimAttendedSession("ses_dead", inAWhile())).not.toBeNull()
  })

  it("REFUSES a session that belongs to a context — those are the agent's to claim", async () => {
    // Fail closed: an agent-owned session goes through claimSessionById, which checks ownership
    // through the context. This must not become a way around that check.
    const m = store()
    // A context needs a real agent and manifest artifact (both hard FKs), so build the chain
    // rather than a dangling id — the FK is enforced here, which is exactly why the relax
    // migration has to suspend it.
    await m.createArtifact({
      id: "a1",
      short_id: "man1",
      org_id: "default",
      slug: null,
      title: "Manifest",
      workspace_access: "member",
      link_role: "viewer",
      listed: "workspace",
      kind: "file",
      spa: 0,
    })
    await m.createAgent({
      id: "ag1",
      org_id: "default",
      name: "a",
      token: "t",
      role: "editor",
      created_by: "u-ed",
    })
    await m.createContext({
      id: "ctx_1",
      org_id: "default",
      name: "cx",
      agent_id: "ag1",
      manifest_artifact_id: "a1",
      created_by: "u-ed",
    })
    await m.createSession({
      id: "ses_ctx",
      context_id: "ctx_1",
      context_version: 1,
      org_id: "default",
      asker_id: "u-ed",
    })
    expect(await m.claimAttendedSession("ses_ctx", inAWhile())).toBeNull()
  })
})
