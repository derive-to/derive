import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { FsBlobStore } from "@derive/storage/fs"
import Database from "better-sqlite3"
import { afterAll, describe, expect, it, vi } from "vitest"
import { createApp } from "../src/app"
import { sha256 } from "../src/lib/crypto"
import { as, jsonAs, makeAuthedApp, type TestUser } from "./helpers"

// Reversible archive and legacy tombstone state transitions exposed by `organize`.

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
  it("archives reversibly: hidden from normal discovery, still readable, and findable on the archive shelf", async () => {
    const { app, meta, token } = await setup("archive-roundtrip")
    const pub = await call(app, token, "publish", {
      title: "Transient probe",
      content: "# Transient probe\n\nbody",
    })

    const gone = await call(app, token, "organize", {
      short_ids: [pub.short_id],
      state: "archived",
    })
    expect(gone.state.changed).toBe(1)
    expect(gone.state.undo).toMatchObject({
      tool: "organize",
      arguments: { short_ids: [pub.short_id], state: "live" },
    })
    expect((await meta.getByShortId(pub.short_id))?.archived_at).toBeTruthy()
    expect((await callRaw(app, token, "read", { short_id: pub.short_id })).isError).toBe(false)

    const normal = await call(app, token, "find", { query: "Transient probe" })
    expect(JSON.stringify(normal)).not.toContain(pub.short_id)
    const shelf = await call(app, token, "find", { archived: true })
    expect(JSON.stringify(shelf)).toContain(pub.short_id)

    const back = await call(app, token, "organize", {
      short_ids: [pub.short_id],
      state: "live",
    })
    expect(back.state.changed).toBe(1)
    expect((await meta.getByShortId(pub.short_id))?.archived_at).toBeNull()
    expect(JSON.stringify(await call(app, token, "find", { query: "Transient probe" }))).toContain(
      pub.short_id,
    )
  })

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
})

describe("organize state:'deleted' — the permanent one", () => {
  const dir = mkdtempSync(join(tmpdir(), "derive-orgdel-"))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  /** An app plus an OAuth bearer at the given scopes — the same seeding the consent dance
   *  produces. `derive:manage` maps to owner grade (capped by the human's real membership),
   *  which is what separates the delete cases below from the publish-grade ones. */
  function appWithGrant(name: string, scopes: string) {
    const path = join(dir, `${name}.db`)
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
    const blobs = new FsBlobStore(join(dir, `${name}-blobs`))
    const app = createApp({ meta, blobs, baseUrl: "http://derive.test", token: "tok" })
    return { app, token: `tok_${name}`, meta, blobs }
  }

  // PERMANENT DELETE on `organize` (state:'deleted'). The capability already existed at
  // REST (DELETE /v1/artifacts/:id, same manage gate) and was simply unreachable from the
  // tool an agent tidies its library with — so finishing a cleanup meant minting a second
  // credential. This is parity, not new power, which is exactly why the gate must MATCH
  // the REST one rather than being relaxed to fit the caller.
  const call = (
    app: ReturnType<typeof appWithGrant>["app"],
    token: string,
    name: string,
    args: Record<string, unknown> = {},
  ) =>
    app.request("/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    })

  const toolJson = async (res: Response) => {
    const ct = res.headers.get("content-type") ?? ""
    const txt = await res.text()
    const out = ct.includes("application/json")
      ? JSON.parse(txt)
      : JSON.parse(
          (txt.split("\n").find((l) => l.startsWith("data:")) ?? "data:null").slice(5).trim(),
        )
    const t = (out?.result as { content?: { text: string }[] })?.content?.[0]?.text
    if (t == null) throw new Error(`no tool text: ${JSON.stringify(out)}`)
    return JSON.parse(t)
  }

  const publish = async (
    app: ReturnType<typeof appWithGrant>["app"],
    token: string,
    title: string,
  ) => {
    const form = new FormData()
    form.append("file", new Blob([new TextEncoder().encode(`<h1>${title}</h1>`)]), "index.html")
    form.append("title", title)
    return (
      await app.request("/v1/artifacts", {
        method: "POST",
        body: form,
        headers: { authorization: `Bearer ${token}` },
      })
    ).json()
  }

  it("deletes for real, and says there is no undo", async () => {
    const { app, token, meta } = appWithGrant(
      "orgdel",
      "openid derive:read derive:publish derive:manage",
    )
    const a = await publish(app, token, "Throwaway")
    expect(await meta.getByShortId(a.short_id)).toBeTruthy()

    const out = await toolJson(
      await call(app, token, "organize", { short_ids: [a.short_id], state: "deleted" }),
    )
    expect(out.state.deleted).toBe(1)
    // Gone from the store, not merely tombstoned.
    expect(await meta.getByShortId(a.short_id)).toBeNull()
    // Every other state change hands back its reversal. This one must NOT pretend to.
    expect(out.state.undo).toBeUndefined()
    expect(out.state.note).toContain("cannot be undone")
    // And it points at the reversible option, since that is usually what was meant.
    expect(out.state.note).toContain("archived")
  })

  it("deletes an artifact that has logged views (the raw-DDL view table's FK)", async () => {
    // Regression: the view ledger is raw DDL with a NOT NULL FK to artifact(id) and no
    // drizzle model, so it was invisible to check-delete-cascade and missing from every
    // delete path. Postgres enforces the FK, so deleting any once-viewed artifact 500d
    // in production while this suite stayed green (better-sqlite3 runs with FK
    // enforcement off) — run under pnpm test:pg, this case is the one that catches it.
    const { app, token, meta } = appWithGrant(
      "orgdelviews",
      "openid derive:read derive:publish derive:manage",
    )
    const a = await publish(app, token, "Viewed then deleted")
    const rec = await meta.getByShortId(a.short_id)
    if (!rec) throw new Error("publish did not land")
    await meta.recordView({
      id: "vw_orgdelviews_1",
      artifact_id: rec.id,
      version: 1,
      viewer: "anon-fingerprint",
      viewer_kind: "anon",
    })
    const out = await toolJson(
      await call(app, token, "organize", { short_ids: [a.short_id], state: "deleted" }),
    )
    expect(out.state.deleted).toBe(1)
    expect(await meta.getByShortId(a.short_id)).toBeNull()
  })

  it("refuses below manage and names the reversible alternative", async () => {
    // publish-grade only: enough to create the artifact, deliberately not enough to
    // destroy it. The REST route draws the line in the same place.
    const { app, token, meta } = appWithGrant("orgdellow", "openid derive:read derive:publish")
    const a = await publish(app, token, "Keeper")

    const out = await toolJson(
      await call(app, token, "organize", { short_ids: [a.short_id], state: "deleted" }),
    )
    expect(out.state.deleted).toBe(0)
    expect(out.state.needs_manage).toEqual([a.short_id])
    expect(out.state.needs_manage_note).toContain("archived")
    // Still there, which is the whole point.
    expect(await meta.getByShortId(a.short_id)).toBeTruthy()
  })

  it("still offers the reversible shelving path at publish grade", async () => {
    // The refusal above must not read as "you cannot clean up" — retiring still works.
    const { app, token, meta } = appWithGrant("orgdelshelf", "openid derive:read derive:publish")
    const a = await publish(app, token, "Shelvable")
    const out = await toolJson(
      await call(app, token, "organize", { short_ids: [a.short_id], state: "removed" }),
    )
    expect(out.state.changed).toBe(1)
    expect(out.state.undo).toMatchObject({ arguments: { state: "live" } })
    expect((await meta.getByShortId(a.short_id))?.removed_at).toBeTruthy()
  })

  it("deletes a batch, skipping what it cannot reach, without failing the call", async () => {
    const { app, token, meta } = appWithGrant(
      "orgdelbatch",
      "openid derive:read derive:publish derive:manage",
    )
    const a = await publish(app, token, "One")
    const b = await publish(app, token, "Two")
    const out = await toolJson(
      await call(app, token, "organize", {
        short_ids: [a.short_id, b.short_id, "nosuchid"],
        state: "deleted",
      }),
    )
    expect(out.state.deleted).toBe(2)
    expect(out.state.skipped).toBe(1)
    expect(await meta.getByShortId(a.short_id)).toBeNull()
    expect(await meta.getByShortId(b.short_id)).toBeNull()
  })
})
