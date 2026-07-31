import { type ArtifactRecord, newId } from "@derive/core"
import { describe, expect, it } from "vitest"
import { authorKind, resolveChannels } from "../src/lib/slack-subscriptions"
import { quotaApp } from "./helpers"

const setup = async (name: string, listed: "none" | "workspace" = "workspace") => {
  const { meta } = quotaApp(name, { defaultOrgId: "default" }, [], [])
  const artifact = (await meta.createArtifact({
    id: newId("a"),
    short_id: newId("s").slice(0, 8),
    org_id: "default",
    slug: null,
    title: "Doc",
    workspace_access: "member",
    link_role: "viewer",
    listed,
    kind: "file",
    spa: 0,
  })) as ArtifactRecord
  return { meta, artifact }
}

const sub = (over: Record<string, unknown> = {}) => ({
  id: newId("sub"),
  org_id: "default",
  channel_id: "C1",
  ...over,
})

describe("resolveChannels", () => {
  it("returns nothing when no channel is subscribed", async () => {
    const { meta, artifact } = await setup("res-none")
    expect(await resolveChannels(meta, artifact, "comment.created", "human")).toHaveLength(0)
  })

  it("delivers a workspace-scoped subscription for any artifact", async () => {
    const { meta, artifact } = await setup("res-ws")
    await meta.upsertSlackSubscription(sub())
    const got = await resolveChannels(meta, artifact, "comment.created", "human")
    expect(got.map((s) => s.channel_id)).toEqual(["C1"])
  })

  it("skips a paused subscription", async () => {
    const { meta, artifact } = await setup("res-paused")
    await meta.upsertSlackSubscription(sub({ active: 0 }))
    expect(await resolveChannels(meta, artifact, "comment.created", "human")).toHaveLength(0)
  })

  it("honours the event mask, and '*' means all", async () => {
    const { meta, artifact } = await setup("res-events")
    await meta.upsertSlackSubscription(sub({ channel_id: "C-pub", events: "version.published" }))
    await meta.upsertSlackSubscription(sub({ channel_id: "C-all", events: "*" }))
    expect(
      (await resolveChannels(meta, artifact, "comment.created", "human")).map((s) => s.channel_id),
    ).toEqual(["C-all"])
    expect(
      (await resolveChannels(meta, artifact, "version.published", "human"))
        .map((s) => s.channel_id)
        .sort(),
    ).toEqual(["C-all", "C-pub"])
  })

  // The axis no other product's integration has: agents are first-class authors here, so a
  // channel usually wants one or the other.
  it("honours the human/agent author filter", async () => {
    const { meta, artifact } = await setup("res-authors")
    await meta.upsertSlackSubscription(sub({ channel_id: "C-humans", authors: "human" }))
    await meta.upsertSlackSubscription(sub({ channel_id: "C-agents", authors: "agent" }))
    await meta.upsertSlackSubscription(sub({ channel_id: "C-both", authors: "all" }))
    expect(
      (await resolveChannels(meta, artifact, "comment.created", "human"))
        .map((s) => s.channel_id)
        .sort(),
    ).toEqual(["C-both", "C-humans"])
    expect(
      (await resolveChannels(meta, artifact, "comment.created", "agent"))
        .map((s) => s.channel_id)
        .sort(),
    ).toEqual(["C-agents", "C-both"])
  })

  it("delivers a collection scope only for artifacts in that collection", async () => {
    const { meta, artifact } = await setup("res-collection")
    const collection = await meta.createCollection({
      id: newId("col"),
      org_id: "default",
      title: "Brand",
      created_by: "u-1",
    })
    await meta.upsertSlackSubscription(
      sub({ channel_id: "C-brand", scope_kind: "collection", scope_id: collection.id }),
    )
    expect(await resolveChannels(meta, artifact, "comment.created", "human")).toHaveLength(0)
    await meta.addCollectionItem(collection.id, artifact.id)
    expect(
      (await resolveChannels(meta, artifact, "comment.created", "human")).map((s) => s.channel_id),
    ).toEqual(["C-brand"])
  })

  // The broadcast rule survives subscriptions: a private draft never reaches a channel, however
  // it was subscribed.
  it("never delivers a private artifact", async () => {
    const { meta, artifact } = await setup("res-private", "none")
    await meta.upsertSlackSubscription(sub())
    expect(await resolveChannels(meta, artifact, "comment.created", "human")).toHaveLength(0)
  })
})

describe("authorKind", () => {
  it("classifies an OAuth grant's synthetic id as an agent", async () => {
    const { meta } = await setup("kind-oauth")
    expect(await authorKind(meta, "default", "oauth:cli")).toBe("agent")
  })

  it("classifies a registered agent as an agent", async () => {
    const { meta } = await setup("kind-agent")
    const agent = await meta.createAgent({
      id: newId("ag"),
      org_id: "default",
      name: "Bot",
      token: "t",
      role: "editor",
      created_by: "u-1",
    })
    expect(await authorKind(meta, "default", agent.id)).toBe("agent")
  })

  // Fail open to human: a filter must never silently hide a person's activity.
  it("treats an unknown or absent author as human", async () => {
    const { meta } = await setup("kind-human")
    expect(await authorKind(meta, "default", "u-someone")).toBe("human")
    expect(await authorKind(meta, "default", null)).toBe("human")
  })
})
