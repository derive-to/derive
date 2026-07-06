import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type ArtifactRecord, artifactUrl, newId, type Visibility } from "@derive/core"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { afterEach, describe, expect, it, vi } from "vitest"
import { homeView, searchResultBlocks, shareCard, unfurlCard } from "../src/lib/slack-cards"
import {
  type DiscoveryDeps,
  handleAppHomeOpened,
  handleLinkShared,
  handleSlashCommand,
  refFromUrl,
  shareArtifact,
} from "../src/lib/slack-discovery"

const KEY = "test-encryption-key"
const baseUrl = "https://derive.test"

const freshStore = () =>
  new SqliteMetaStore(join(mkdtempSync(join(tmpdir(), "derive-slackdisc-")), "db.sqlite"))

const deps = (meta: SqliteMetaStore): DiscoveryDeps => ({ meta, baseUrl, encryptionKey: KEY })

const connect = (meta: SqliteMetaStore, team = "T1") =>
  meta.setSlackInstall({
    org_id: "default",
    team_id: team,
    team_name: "Acme",
    bot_token: "xoxb-plain", // decryptSecret passes non-"v1." blobs through unchanged
    bot_user_id: "UBOT",
    default_channel: "C1",
    created_at: new Date().toISOString(),
  })

const artifact = (
  meta: SqliteMetaStore,
  title: string,
  visibility: Visibility = "public",
): Promise<ArtifactRecord> =>
  meta.createArtifact({
    id: newId("a"),
    // Real short ids are hyphen-free (slug URLs reverse on the last hyphen), so strip
    // any nanoid `-`/`_` here or the URL round-trip in the unfurl test would break.
    short_id: newId("s")
      .replace(/[^a-z0-9]/gi, "")
      .slice(0, 8),
    org_id: "default",
    slug: null,
    title,
    visibility,
    kind: "file",
    spa: 0,
  }) as Promise<ArtifactRecord>

// A fetch stub that records every Slack API call by method + parsed body.
const stubSlack = () => {
  const calls: { url: string; body: Record<string, unknown> }[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? "{}")
      calls.push({ url, body })
      if (url.endsWith("/chat.postMessage"))
        return new Response(JSON.stringify({ ok: true, ts: "1.1", channel: body.channel }))
      return new Response(JSON.stringify({ ok: true }))
    }),
  )
  return calls
}
const hit = (calls: { url: string; body: Record<string, unknown> }[], method: string) =>
  calls.find((c) => c.url.endsWith(method))

afterEach(() => vi.unstubAllGlobals())

describe("refFromUrl", () => {
  it("pulls the short id off a slug URL, a bare-ref URL, and rejects non-artifact URLs", () => {
    expect(refFromUrl("https://derive.test/artifacts/my-title-abcd1234")).toBe("abcd1234")
    expect(refFromUrl("https://derive.test/artifacts/abcd1234")).toBe("abcd1234")
    expect(refFromUrl("https://derive.test/settings")).toBeNull()
    expect(refFromUrl("not a url")).toBeNull()
  })
})

describe("card builders", () => {
  const a = {
    short_id: "abcd1234",
    title: "Design",
    url: `${baseUrl}/artifacts/design-abcd1234`,
    kind: "file",
    version: 2,
  }
  it("unfurlCard links the title", () => {
    expect(JSON.stringify(unfurlCard(a))).toContain(a.url)
  })
  it("shareCard carries an Open button + text fallback", () => {
    const c = shareCard(a)
    expect(c.text).toContain(a.url)
    expect(JSON.stringify(c.blocks)).toContain("Open in Derive")
  })
  it("searchResultBlocks gives each hit a share button", () => {
    const blocks = JSON.stringify(searchResultBlocks("q", [a], "default"))
    expect(blocks).toContain("slack_act:share")
    expect(blocks).toContain(a.title)
  })
  it("homeView prompts to link when unlinked, greets when linked", () => {
    expect(JSON.stringify(homeView({ linkedName: null, items: [], baseUrl }))).toContain(
      "Link your Slack account",
    )
    expect(JSON.stringify(homeView({ linkedName: "Ada", items: [a], baseUrl }))).toContain("Ada")
  })
})

describe("handleSlashCommand", () => {
  it("find returns an ephemeral list of matching shareable artifacts", async () => {
    const meta = freshStore()
    await connect(meta)
    const a = await artifact(meta, "Roadmap")
    await artifact(meta, "Secret", "private") // must be filtered out
    const res = await handleSlashCommand(deps(meta), {
      team_id: "T1",
      channel_id: "C9",
      text: "find Road",
    })
    const json = JSON.stringify(res.blocks)
    expect(res.response_type).toBe("ephemeral")
    expect(json).toContain(a.short_id)
    expect(json).not.toContain("Secret")
  })

  it("share posts the card to the channel and confirms", async () => {
    const meta = freshStore()
    await connect(meta)
    const a = await artifact(meta, "Launch plan")
    const calls = stubSlack()
    const res = await handleSlashCommand(deps(meta), {
      team_id: "T1",
      channel_id: "C9",
      text: `share ${a.short_id}`,
    })
    expect(res.text).toContain("Shared")
    const post = hit(calls, "/chat.postMessage")
    expect(post?.body.channel).toBe("C9")
    expect(JSON.stringify(post?.body.blocks)).toContain(a.short_id)
  })

  it("won't share a private artifact", async () => {
    const meta = freshStore()
    await connect(meta)
    const a = await artifact(meta, "Confidential", "private")
    const calls = stubSlack()
    const res = await handleSlashCommand(deps(meta), {
      team_id: "T1",
      channel_id: "C9",
      text: `share ${a.short_id}`,
    })
    expect(res.text).toContain("Couldn't share")
    expect(hit(calls, "/chat.postMessage")).toBeUndefined()
  })

  it("tells an unconnected workspace it isn't linked", async () => {
    const meta = freshStore()
    const res = await handleSlashCommand(deps(meta), { team_id: "T-unknown", text: "find x" })
    expect(res.text).toContain("isn't connected")
  })
})

describe("handleLinkShared (unfurls)", () => {
  it("unfurls a shareable artifact link, skips a private one", async () => {
    const meta = freshStore()
    await connect(meta)
    const pub = await artifact(meta, "Public doc")
    const priv = await artifact(meta, "Private doc", "private")
    const calls = stubSlack()
    const pubUrl = artifactUrl(baseUrl, pub)
    const privUrl = artifactUrl(baseUrl, priv)
    await handleLinkShared(deps(meta), "T1", {
      channel: "C9",
      message_ts: "5.5",
      links: [{ url: pubUrl }, { url: privUrl }],
    })
    const unfurl = hit(calls, "/chat.unfurl")
    expect(unfurl?.body.channel).toBe("C9")
    const unfurls = unfurl?.body.unfurls as Record<string, unknown>
    expect(Object.keys(unfurls)).toEqual([pubUrl]) // only the public link
  })

  it("no-ops when the team isn't connected", async () => {
    const meta = freshStore()
    const calls = stubSlack()
    await handleLinkShared(deps(meta), "T-none", {
      channel: "C9",
      message_ts: "5.5",
      links: [{ url: `${baseUrl}/artifacts/x-abcd1234` }],
    })
    expect(hit(calls, "/chat.unfurl")).toBeUndefined()
  })
})

describe("handleAppHomeOpened", () => {
  it("publishes a linked greeting when the user has a confirmed link", async () => {
    const meta = freshStore()
    await connect(meta)
    await artifact(meta, "Recent doc")
    await meta.setSlackUserLink({
      id: newId("sul"),
      org_id: "default",
      slack_user_id: "USER1",
      user_id: "u-1",
      status: "confirmed",
      dm_channel_id: null,
      created_at: new Date().toISOString(),
    })
    const calls = stubSlack()
    await handleAppHomeOpened(deps(meta), "T1", { user: "USER1", tab: "home" })
    const pub = hit(calls, "/views.publish")
    expect(pub?.body.user_id).toBe("USER1")
    const view = JSON.stringify(pub?.body.view)
    expect(view).toContain("Recent doc") // recent artifact rendered
    expect(view).not.toContain("Link your Slack account") // linked ⇒ no link prompt
  })

  it("publishes a link prompt when the user is not linked", async () => {
    const meta = freshStore()
    await connect(meta)
    const calls = stubSlack()
    await handleAppHomeOpened(deps(meta), "T1", { user: "USER-NEW", tab: "home" })
    const view = JSON.stringify(hit(calls, "/views.publish")?.body.view)
    expect(view).toContain("Link your Slack account")
  })
})

describe("shareArtifact gate", () => {
  it("returns false for an artifact in another org", async () => {
    const meta = freshStore()
    await connect(meta)
    const install = await meta.getSlackInstall("default")
    if (!install) throw new Error("install missing")
    const a = await meta.createArtifact({
      id: newId("a"),
      short_id: newId("s").slice(0, 8),
      org_id: "other-org",
      slug: null,
      title: "Foreign",
      visibility: "public",
      kind: "file",
      spa: 0,
    })
    stubSlack()
    expect(await shareArtifact(deps(meta), install, "C9", a.short_id)).toBe(false)
  })
})
