import { newId } from "@derive/core"
import { describe, expect, it, vi } from "vitest"
import { afterPublish } from "../src/lib/after-publish"
import { contentMentionHandles } from "../src/lib/content-mentions"
import { as, makeAuthedApp, pub, type TestUser } from "./helpers"

const owner: TestUser = { id: "u-own", email: "own@x.com", name: "Owner", username: "own" }
const editor: TestUser = { id: "u-ed", email: "ed@x.com", name: "Ed", username: "edd" }
const outsider: TestUser = { id: "u-out", email: "out@x.com", name: "Out", username: "out" }

const claim = (meta: Awaited<ReturnType<typeof makeAuthedApp>>["meta"]) =>
  meta.claimDueDeliveries(
    new Date(Date.now() + 60_000).toISOString(),
    100,
    new Date(Date.now() + 120_000).toISOString(),
  )

describe("live artifact content mentions", () => {
  it("recognizes visible prose only, not code, email addresses, or HTML non-prose content", () => {
    expect(
      contentMentionHandles(
        "# Please ask @EDD\n\n`@own is an example`\n\n```ts\nconst person = '@out'\n```\n\nmail own@x.test https://derive.test/users/@out",
        "text/markdown",
      ),
    ).toEqual(["edd"])
    expect(
      contentMentionHandles(
        '<head><title>@own</title></head><script>const person = "@edd"</script><template>@out</template><pre>@out</pre><p>Review with @edd.</p><a href="mailto:@out">mail</a> https://derive.test/users/@out',
        "text/html",
      ),
    ).toEqual(["edd"])
    expect(contentMentionHandles("<code>@own</code> Please ask @edd.", "text/markdown")).toEqual([
      "edd",
    ])
  })

  it("notifies a collaborator only when a live edit introduces their handle, and emails the body context", async () => {
    const { app, meta } = makeAuthedApp("content-mention-edit", [owner, editor, outsider], "editor")
    // Leave a searchable account outside this workspace. A public handle in source must never
    // use the bell as a cross-workspace messaging channel.
    await meta.removeMembership("default", outsider.id)
    const made = await pub(
      app,
      "<p>Initial live copy.</p>",
      { title: "Live content mention", visibility: "org" },
      undefined,
      as(owner.email),
    )
    expect(made.status).toBe(201)
    const { short_id: shortId } = (await made.json()) as { short_id: string }
    await meta.setSlackInstall({
      org_id: "default",
      team_id: "T-content-mention",
      team_name: "Content mentions",
      bot_token: "xoxb-content-mention",
      bot_user_id: "U-content-mention",
      created_at: new Date().toISOString(),
    })

    const introduced = await pub(
      app,
      "<p>@edd, please review this live body before launch.</p><p>@out is not a collaborator.</p>",
      {},
      shortId,
      as(owner.email),
    )
    expect(introduced.status).toBe(201)
    const first = await meta.listNotifications(editor.id, 20)
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({
      kind: "mention",
      actor: "Owner",
      artifact_short_id: shortId,
      thread_id: "",
      comment_id: "",
    })
    expect(first[0]?.preview).toContain("@edd")
    expect(await meta.listNotifications(outsider.id, 20)).toHaveLength(0)
    const rendered = await app.request(`/v1/artifacts/${shortId}/mentions`, {
      headers: as(owner.email),
    })
    expect(rendered.status).toBe(200)
    expect(await rendered.json()).toEqual({ handles: ["edd"] })

    // Retaining a handle during a later edit is ordinary document maintenance, not a second ping.
    const retained = await pub(
      app,
      "<p>@edd, please review this live body before launch. Updated for clarity.</p>",
      {},
      shortId,
      as(owner.email),
    )
    expect(retained.status).toBe(201)
    expect(await meta.listNotifications(editor.id, 20)).toHaveLength(1)

    const deliveries = await claim(meta)
    const emails = deliveries.filter((delivery) => delivery.kind === "email")
    expect(emails).toHaveLength(1)
    expect(emails[0]?.payload).toContain(editor.email)
    expect(emails[0]?.payload).toContain("mentioned you in Live content mention")
    expect(emails[0]?.payload).toContain("review this live body")
    const slackDm = deliveries.find((delivery) => delivery.kind === "slack_dm")
    expect(slackDm?.payload).toContain(editor.id)
    expect(slackDm?.payload).toContain("review this live body")
    expect(slackDm?.payload).not.toContain('"mention"')
  })

  it("does not leak an invite-only document mention to a workspace seat without document access", async () => {
    const { app, meta } = makeAuthedApp("content-mention-invite-only", [owner, editor], "editor")
    const made = await pub(
      app,
      "<p>Initial private copy.</p>",
      {
        title: "Invite-only mention",
        workspace_access: "none",
        link_role: "none",
        listed: "none",
      },
      undefined,
      as(owner.email),
    )
    expect(made.status).toBe(201)
    const { short_id: shortId } = (await made.json()) as { short_id: string }

    const updated = await pub(
      app,
      "<p>@edd, this stays in an invite-only document.</p>",
      {},
      shortId,
      as(owner.email),
    )
    expect(updated.status).toBe(201)
    expect(await meta.listNotifications(editor.id, 20)).toHaveLength(0)
  })

  it("never lets a body-notification failure interrupt a version that is already live", async () => {
    const { app, meta, ctx } = makeAuthedApp("content-mention-failure", [owner, editor], "editor")
    const made = await pub(
      app,
      "<p>Initial live copy.</p>",
      { title: "Failure isolation", visibility: "org" },
      undefined,
      as(owner.email),
    )
    const { short_id: shortId } = (await made.json()) as { short_id: string }
    const artifact = await meta.getByShortId(shortId)
    if (!artifact) throw new Error("artifact missing")
    const blob_key = await ctx.blobs.put(new TextEncoder().encode("<p>@edd, can you review?</p>"))
    const version = await meta.addVersion(artifact.id, {
      id: newId("v"),
      blob_key,
      content_type: "text/html",
      size_bytes: 31,
      author: owner.name ?? "Owner",
      author_id: owner.id,
      source: "web",
      message: null,
      name: null,
    })
    const notificationWrite = vi.fn(async () => {
      throw new Error("notification store unavailable")
    })
    const failingMeta = new Proxy(meta, {
      get(target, prop, receiver) {
        if (prop === "createNotifications") return notificationWrite
        return Reflect.get(target, prop, receiver)
      },
    })

    await expect(
      afterPublish(
        {
          meta: failingMeta,
          blobs: ctx.blobs,
          bus: { publish: () => {}, subscribe: () => () => {} } as never,
          notify: async () => {},
          background: async (work) => {
            await work
          },
        },
        artifact,
        version,
        { isNew: false, onBehalf: owner.id, actorId: owner.id },
      ),
    ).resolves.toEqual({ resolved: [] })

    expect(notificationWrite).toHaveBeenCalledTimes(1)
    expect((await meta.getVersion(artifact.id, version.n))?.blob_key).toBe(blob_key)
  })

  it("keeps lexical search and authored facts synchronous while preview convergence is deferred", async () => {
    const { meta, ctx } = makeAuthedApp("preview-fast-commit", [owner], "editor")
    const source = `<!doctype html><html><body><main><section id="fast-tail"><h2>Immediate needle</h2><p>Long artifact body.</p></section></main><script type="application/derive-facts" data-fact="authored">{"ready":true}</script></body></html>`
    const blobKey = await ctx.blobs.put(new TextEncoder().encode(source))
    const artifact = await meta.createArtifact({
      id: newId("a"),
      short_id: "fastcommit",
      title: "Fast commit fixture",
      kind: "file",
      org_id: "default",
      slug: null,
      spa: 0,
      workspace_access: "member",
      link_role: "none",
      listed: "none",
    })
    const version = await meta.addVersion(artifact.id, {
      id: newId("v"),
      blob_key: blobKey,
      content_type: "text/html",
      size_bytes: source.length,
      author: "Owner",
      author_id: owner.id,
      source: "web",
      message: null,
      name: null,
    })

    let releaseDense = () => {}
    const denseGate = new Promise<void>((resolve) => {
      releaseDense = resolve
    })
    let markDenseStarted = () => {}
    const denseStarted = new Promise<void>((resolve) => {
      markDenseStarted = resolve
    })
    const search = {
      indexArtifact: vi.fn(async () => {
        markDenseStarted()
        await denseGate
      }),
    }
    const deferred: Promise<unknown>[] = []

    await afterPublish(
      {
        meta,
        blobs: ctx.blobs,
        bus: { publish: () => {}, subscribe: () => () => {} } as never,
        notify: async () => {},
        background: async (work) => {
          deferred.push(work)
        },
        search: search as never,
        deferVersionConvergence: true,
      },
      artifact,
      version,
      { isNew: false, onBehalf: owner.id, actorId: owner.id, preparedSource: source },
    )
    await denseStarted

    expect(await meta.searchArtifactIds("default", "needle", 10)).toMatchObject([
      { id: artifact.id },
    ])
    expect(await meta.getVersionData(artifact.id, version.n)).toMatchObject([
      { slot: "authored", json: '{"ready":true}' },
    ])
    expect(
      (await meta.getVersionData(artifact.id, version.n)).some((row) => row.slot === "$map"),
    ).toBe(false)

    releaseDense()
    await Promise.all(deferred)
    expect(search.indexArtifact).toHaveBeenCalledTimes(1)
    expect(
      (await meta.getVersionData(artifact.id, version.n)).some((row) => row.slot === "$map"),
    ).toBe(true)
  })

  it("keeps the default convergence path synchronous", async () => {
    const { meta, ctx } = makeAuthedApp("default-convergence", [owner], "editor")
    const source = "<main><section id=default-path><h2>Default path</h2></section></main>"
    const blobKey = await ctx.blobs.put(new TextEncoder().encode(source))
    const artifact = await meta.createArtifact({
      id: newId("a"),
      short_id: "defaultpath",
      title: "Default convergence fixture",
      kind: "file",
      org_id: "default",
      slug: null,
      spa: 0,
      workspace_access: "member",
      link_role: "none",
      listed: "none",
    })
    const version = await meta.addVersion(artifact.id, {
      id: newId("v"),
      blob_key: blobKey,
      content_type: "text/html",
      size_bytes: source.length,
      author: "Owner",
      author_id: owner.id,
      source: "web",
      message: null,
      name: null,
    })
    let releaseDense = () => {}
    const denseGate = new Promise<void>((resolve) => {
      releaseDense = resolve
    })
    let markDenseStarted = () => {}
    const denseStarted = new Promise<void>((resolve) => {
      markDenseStarted = resolve
    })
    let returned = false
    const work = afterPublish(
      {
        meta,
        blobs: ctx.blobs,
        bus: { publish: () => {}, subscribe: () => () => {} } as never,
        notify: async () => {},
        background: async (task) => {
          await task
        },
        search: {
          indexArtifact: async () => {
            markDenseStarted()
            await denseGate
          },
        } as never,
      },
      artifact,
      version,
      { isNew: false, onBehalf: owner.id, actorId: owner.id, preparedSource: source },
    ).then(() => {
      returned = true
    })
    await denseStarted
    expect(returned).toBe(false)
    releaseDense()
    await work
    expect(returned).toBe(true)
    expect(
      (await meta.getVersionData(artifact.id, version.n)).some((row) => row.slot === "$map"),
    ).toBe(true)
  })

  it("lets an agent publish a live-body handoff back to the person it acts for", async () => {
    const { app, meta, ctx } = makeAuthedApp("content-mention-agent-handoff", [owner], "editor")
    const made = await pub(
      app,
      "<p>Initial live copy.</p>",
      { title: "Agent handoff", visibility: "org" },
      undefined,
      as(owner.email),
    )
    const { short_id: shortId } = (await made.json()) as { short_id: string }
    const artifact = await meta.getByShortId(shortId)
    if (!artifact) throw new Error("artifact missing")
    const blob_key = await ctx.blobs.put(new TextEncoder().encode("<p>@own, please decide.</p>"))
    const version = await meta.addVersion(artifact.id, {
      id: newId("v"),
      blob_key,
      content_type: "text/html",
      size_bytes: 26,
      author: "Derive Agent",
      // The version is attributed to Owner, exactly as a delegated publish is in production.
      author_id: owner.id,
      source: "mcp",
      message: null,
      name: null,
    })
    await afterPublish(
      {
        meta,
        blobs: ctx.blobs,
        bus: { publish: () => {}, subscribe: () => () => {} } as never,
        notify: async () => {},
        background: async (work) => {
          await work
        },
      },
      artifact,
      version,
      { isNew: false, onBehalf: owner.id, actorId: "agent_live_handoff" },
    )
    expect(await meta.listNotifications(owner.id, 20)).toMatchObject([
      { kind: "mention", actor: "Derive Agent", thread_id: "", comment_id: "" },
    ])
  })
})
