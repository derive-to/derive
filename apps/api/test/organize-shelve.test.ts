import { describe, expect, it, vi } from "vitest"
import { as, jsonAs, makeAuthedApp, type TestUser } from "./helpers"

// SHELVING on `organize` — the authoring path for removal, and the way back.
//
// The tombstone itself is old: sync retires an artifact whose file was deleted, moderation
// takes one down, PR-preview teardown sweeps a batch. What never existed was a path for the
// PERSON (or agent) who made a thing to remove it, which meant every experiment in a real
// workspace was permanent litter. Both directions live on ONE parameter so the way back is
// never a separate thing to discover.

const owner: TestUser = { id: "u_shelf", email: "shelf@derive.test", name: "Owner" }
type App = ReturnType<typeof makeAuthedApp>["app"]

const callRaw = async (
  app: App,
  token: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ text: string; isError: boolean }> => {
  const res = await app.request("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  })
  const ct = res.headers.get("content-type") ?? ""
  const txt = await res.text()
  const out = ct.includes("application/json")
    ? JSON.parse(txt)
    : JSON.parse(
        (txt.split("\n").find((l) => l.startsWith("data:")) ?? "data:null").slice(5).trim(),
      )
  const r = out?.result as { content?: { text: string }[]; isError?: boolean } | undefined
  const t = r?.content?.[0]?.text
  if (t == null) throw new Error(`no tool text: ${JSON.stringify(out)}`)
  return { text: t, isError: !!r?.isError }
}
// biome-ignore lint/suspicious/noExplicitAny: test convenience over a JSON payload
const call = async (app: App, token: string, name: string, args = {}): Promise<any> =>
  JSON.parse((await callRaw(app, token, name, args)).text)

const setup = async (name: string) => {
  const { app, meta } = makeAuthedApp(name, [owner], "editor")
  await app.request("/v1/me", { headers: as(owner.email) })
  const bot = await (
    await app.request("/v1/agents", jsonAs(as(owner.email), { name: "ShelfBot", role: "editor" }))
  ).json()
  return { app, meta, token: bot.token as string }
}

describe("organize state — retire an artifact and put it back", () => {
  it("round-trips: removed hides it, live restores it, and the record survives both", async () => {
    const { app, meta, token } = await setup("shelve-roundtrip")
    const pub = await call(app, token, "publish", { title: "Probe", content: "# Probe\n\nbody" })
    const art = await meta.getByShortId(pub.short_id)
    if (!art) throw new Error("artifact missing")

    const gone = await call(app, token, "organize", {
      short_ids: [pub.short_id],
      state: "removed",
    })
    expect(gone.state.changed).toBe(1)
    expect(gone.state.skipped).toBe(0)
    // Tombstoned, never deleted — the row and its versions are still there.
    expect((await meta.getByShortId(pub.short_id))?.removed_at).toBeTruthy()
    expect(await meta.getArtifactById(art.id)).toBeTruthy()

    // The way back is handed over at the moment it might be wanted, as a runnable call.
    expect(gone.state.undo).toMatchObject({
      tool: "organize",
      arguments: { short_ids: [pub.short_id], state: "live" },
    })

    const back = await call(app, token, "organize", { short_ids: [pub.short_id], state: "live" })
    expect(back.state.changed).toBe(1)
    expect((await meta.getByShortId(pub.short_id))?.removed_at).toBeNull()
    // ...and its undo points the other way, so the pair is symmetric.
    expect(back.state.undo).toMatchObject({ arguments: { state: "removed" } })
  })

  it("reads as removed once retired, and readable again once restored", async () => {
    const { app, token } = await setup("shelve-read")
    const pub = await call(app, token, "publish", { title: "Gone", content: "# Gone\n\nbody" })
    // Readable to begin with.
    expect((await callRaw(app, token, "read", { short_id: pub.short_id })).isError).toBe(false)

    await call(app, token, "organize", { short_ids: [pub.short_id], state: "removed" })
    const afterRemove = await callRaw(app, token, "read", { short_id: pub.short_id })
    expect(afterRemove.isError).toBe(true)

    // Restoring makes it readable again: the whole point of pairing the directions.
    await call(app, token, "organize", { short_ids: [pub.short_id], state: "live" })
    expect((await callRaw(app, token, "read", { short_id: pub.short_id })).isError).toBe(false)
  })

  it("refuses an unknown state by name, rather than failing a schema check", async () => {
    const { app, token } = await setup("shelve-bad")
    const pub = await call(app, token, "publish", { title: "X", content: "# X\n\nbody" })
    const bad = await callRaw(app, token, "organize", {
      short_ids: [pub.short_id],
      state: "deleted",
    })
    // A growth-prone discriminator: checked server-side so a client with a cached schema
    // can still reach a value shipped after it connected, and a wrong one is named.
    expect(bad.text).toContain("removed, live")
    expect(bad.isError).toBe(true)
  })

  it("skips artifacts the caller can't edit instead of failing the batch", async () => {
    const { app, meta, token } = await setup("shelve-skip")
    const mine = await call(app, token, "publish", { title: "Mine", content: "# Mine\n\nbody" })
    const out = await call(app, token, "organize", {
      short_ids: [mine.short_id, "zzzzzzzz"],
      state: "removed",
    })
    // The reachable one is retired; the unreachable one is counted, not thrown.
    expect(out.state.changed).toBe(1)
    expect(out.state.skipped).toBe(1)
    expect((await meta.getByShortId(mine.short_id))?.removed_at).toBeTruthy()
    // And the undo names ONLY what changed. Echoing the whole input would hand back a call
    // claiming to restore an artifact that was skipped and never retired.
    expect(out.state.undo.arguments.short_ids).toEqual([mine.short_id])
  })

  it("warns when the artifact is repo-synced, because sync will undo the retirement", async () => {
    // sync.ts clears removed_at whenever it republishes a changed file, so retiring a
    // synced artifact does not stay retired — and nothing would have said why it came
    // back. Allowed (it is what you asked for today) but never silent.
    const { app, meta, token } = await setup("shelve-synced")
    const pub = await call(app, token, "publish", { title: "Synced", content: "# Synced\n\nbody" })
    const art = await meta.getByShortId(pub.short_id)
    if (!art) throw new Error("artifact missing")
    await meta.setArtifactSourcePath(art.id, "docs/synced.md")

    const gone = await call(app, token, "organize", {
      short_ids: [pub.short_id],
      state: "removed",
    })
    expect(gone.state.changed).toBe(1)
    expect(gone.state.synced_from_repo).toEqual([pub.short_id])
    expect(gone.state.synced_from_repo_note).toContain("remove the file at the source")

    // Restoring says nothing about sync: there is no surprise to warn about that way.
    const back = await call(app, token, "organize", { short_ids: [pub.short_id], state: "live" })
    expect(back.state.synced_from_repo).toBeUndefined()
  })

  it("will not let an editor reverse a MODERATION takedown", async () => {
    // removed_at means two different things. An author retiring their own draft is the
    // cheap one; an admin taking content down is not, and it also resolves the open
    // reports. If the editor bar could clear it, a takedown could be undone silently and
    // the content would never resurface in the moderation queue.
    const { app, meta, token } = await setup("shelve-moderated")
    const pub = await call(app, token, "publish", { title: "Bad", content: "# Bad\n\nbody" })
    const art = await meta.getByShortId(pub.short_id)
    if (!art) throw new Error("artifact missing")

    // Taken down the way moderation does it: the tombstone plus its audit row.
    await meta.setArtifactRemoved(art.id, new Date().toISOString())
    await meta.createAuditLog({
      id: "au_test_1",
      org_id: art.org_id,
      action: "takedown",
      artifact_id: art.id,
      actor: "an-admin",
      detail: "abuse",
    })

    const tryBack = await call(app, token, "organize", {
      short_ids: [pub.short_id],
      state: "live",
    })
    expect(tryBack.state.changed).toBe(0)
    expect(tryBack.state.moderation_hold).toEqual([pub.short_id])
    expect(tryBack.state.moderation_hold_note).toContain("manage-level")
    // Still down, which is the whole point.
    expect((await meta.getByShortId(pub.short_id))?.removed_at).toBeTruthy()
  })

  it("still restores normally once moderation has reinstated it", async () => {
    // The guard reads the STANDING decision, not merely "was ever taken down": after a
    // reinstate, an author's own retire/restore works again.
    const { app, meta, token } = await setup("shelve-reinstated")
    const pub = await call(app, token, "publish", { title: "Ok", content: "# Ok\n\nbody" })
    const art = await meta.getByShortId(pub.short_id)
    if (!art) throw new Error("artifact missing")
    const row = (action: "takedown" | "reinstate", id: string) => ({
      id,
      org_id: art.org_id,
      action,
      artifact_id: art.id,
      actor: "an-admin",
      detail: null,
    })
    // TWO MODERATION ACTIONS AT TWO STATED TIMES, rather than two writes racing one clock.
    //
    // The store owns `created_at` (no `New*` port type accepts one) and stamps it with a
    // MILLISECOND ISO string. These two inserts land about a quarter of a millisecond apart, so
    // left to the real clock they routinely share a millisecond — measured here at roughly one
    // run in four. `listAuditLog` orders on that column alone, and Postgres breaks the tie in
    // physical scan order, which is insertion order: the takedown comes back first, the guard
    // reads it as the STANDING decision, and the restore is refused. SQLite's sorter happens to
    // break the identical tie the other way, which is why this only ever failed on the pg lane
    // and why it moved around between files run to run instead of pointing at itself.
    //
    // The ORDER IS THE FIXTURE here — "reinstated after a takedown" is the entire subject of the
    // test — so it is set rather than hoped for. Only `Date` is faked: the awaits below are real
    // Postgres round trips and still need real timers.
    vi.useFakeTimers({ toFake: ["Date"] })
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"))
      await meta.createAuditLog(row("takedown", "au_test_2"))
      vi.setSystemTime(new Date("2026-01-01T00:00:01.000Z"))
      await meta.createAuditLog(row("reinstate", "au_test_3"))
    } finally {
      vi.useRealTimers()
    }

    await call(app, token, "organize", { short_ids: [pub.short_id], state: "removed" })
    const back = await call(app, token, "organize", { short_ids: [pub.short_id], state: "live" })
    expect(back.state.changed).toBe(1)
    expect(back.state.moderation_hold).toBeUndefined()
  })

  it("warns when the artifact is a live context's manifest", async () => {
    // A context cannot outlive its manifest — hard delete cascades it — but shelving is
    // not a delete, so the context stays askable and its RUNNER hits the takedown error
    // minutes later, in another process, with nothing pointing back here.
    const { app, meta, token } = await setup("shelve-manifest")
    const man = await call(app, token, "publish", {
      title: "Manifest",
      content: "---\nname: c\n---\n\n# Manifest",
    })
    const art = await meta.getByShortId(man.short_id)
    if (!art) throw new Error("artifact missing")
    const bot = await (
      await app.request("/v1/agents", jsonAs(as(owner.email), { name: "CtxBot", role: "editor" }))
    ).json()
    await meta.createContext({
      id: "ctx_shelf_1",
      org_id: art.org_id,
      name: "qa-ctx",
      agent_id: bot.id,
      manifest_artifact_id: art.id,
      created_by: owner.id,
    })

    const gone = await call(app, token, "organize", {
      short_ids: [man.short_id],
      state: "removed",
    })
    // Allowed — decommissioning a context is a real thing to want — but never silent.
    expect(gone.state.changed).toBe(1)
    expect(gone.state.in_use_by_contexts).toEqual([{ short_id: man.short_id, context: "qa-ctx" }])
    expect(gone.state.in_use_by_contexts_note).toContain("runner will fail")
  })

  it("still needs short_ids, and says so", async () => {
    const { app, token } = await setup("shelve-noids")
    const bare = await callRaw(app, token, "organize", { state: "removed" })
    expect(bare.isError).toBe(true)
    expect(bare.text).toContain("short_ids")
  })
})
