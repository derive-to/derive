import { newId } from "@derive/core"
import { describe, expect, it, vi } from "vitest"
import { afterPublish } from "../src/lib/after-publish"
import { contentMentionHandles, fanOutNewContentMentions } from "../src/lib/content-mentions"
import { as, makeAuthedApp, proposeAs, pub, type TestUser } from "./helpers"

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

  it("fans out a newly introduced body mention when an approved proposal becomes live", async () => {
    const { app, meta } = makeAuthedApp("content-mention-proposal", [owner, editor], "editor")
    const made = await pub(
      app,
      "<p>Initial live copy.</p>",
      { title: "Proposal body mention", visibility: "org" },
      undefined,
      as(owner.email),
    )
    const { short_id: shortId } = (await made.json()) as { short_id: string }
    const proposed = await proposeAs(
      app,
      shortId,
      "<p>@own, this body mention lands with the approved proposal.</p>",
      as(editor.email),
    )
    expect(proposed.status).toBe(201)
    const { id: proposalId } = (await proposed.json()) as { id: string }

    const approved = await app.request(`/v1/artifacts/${shortId}/proposals/${proposalId}/approve`, {
      method: "POST",
      headers: as(owner.email),
    })
    expect(approved.status).toBe(200)
    expect(await meta.listNotifications(owner.id, 20)).toMatchObject([
      { kind: "mention", actor: "Ed", thread_id: "", comment_id: "" },
    ])
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

  it("can run the fan-out directly for focused integration callers without turning a notification error into a throw", async () => {
    const { app, meta, ctx } = makeAuthedApp(
      "content-mention-direct-failure",
      [owner, editor],
      "editor",
    )
    const made = await pub(
      app,
      "<p>Initial live copy.</p>",
      { title: "Direct failure isolation", visibility: "org" },
      undefined,
      as(owner.email),
    )
    const { short_id: shortId } = (await made.json()) as { short_id: string }
    const artifact = await meta.getByShortId(shortId)
    if (!artifact) throw new Error("artifact missing")
    const blob_key = await ctx.blobs.put(new TextEncoder().encode("<p>@edd, please review.</p>"))
    const version = await meta.addVersion(artifact.id, {
      id: newId("v"),
      blob_key,
      content_type: "text/html",
      size_bytes: 28,
      author: owner.name ?? "Owner",
      author_id: owner.id,
      source: "web",
      message: null,
      name: null,
    })
    const failingMeta = new Proxy(meta, {
      get(target, prop, receiver) {
        if (prop === "createNotifications")
          return async () => {
            throw new Error("notification store unavailable")
          }
        return Reflect.get(target, prop, receiver)
      },
    })
    await expect(
      fanOutNewContentMentions(
        { meta: failingMeta, blobs: ctx.blobs, bus: { publish: () => {} } as never },
        artifact,
        version,
      ),
    ).resolves.toBeUndefined()
  })
})
