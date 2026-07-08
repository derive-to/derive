import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { newId, type RepoSourceRecord } from "@derive/core"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { FsBlobStore } from "@derive/storage/fs"
import Database from "better-sqlite3"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { createApp } from "../src/app"
import { runSync } from "../src/lib/sync"

// ---- GitHub repo fake (one repo's tree + blobs + last-commit per path) ------
let tree: { path: string; sha: string; type: "blob" | "tree" }[] = []
// repo path → the commit element the Commits API returns (date + authors).
const commits: Record<
  string,
  {
    commit?: { committer?: { date?: string }; author?: { name?: string; email?: string } }
    author?: { login?: string; id?: number; avatar_url?: string } | null
  }
> = {}
const blobs: Record<string, string> = {}

const dir = mkdtempSync(join(tmpdir(), "derive-author-test-"))
const dbPath = join(dir, "a.db")
const meta = new SqliteMetaStore(dbPath)
const blobStore = new FsBlobStore(join(dir, "blobs"))
const app = createApp({ meta, blobs: blobStore, baseUrl: "http://derive.test", token: "tok" })
const NOW = "2026-06-17T00:00:00.000Z"
const auth = { authorization: "Bearer tok" }

beforeAll(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      const s = String(url)
      if (s.includes("/git/trees/")) return new Response(JSON.stringify({ tree, truncated: false }))
      if (s.includes("/commits?")) {
        const path = new URL(s).searchParams.get("path") ?? ""
        const c = commits[path]
        return new Response(JSON.stringify(c ? [c] : []))
      }
      const m = s.match(/\/git\/blobs\/([^/?]+)/)
      if (m) {
        const body = blobs[m[1] as string]
        return body == null ? new Response("nf", { status: 404 }) : new Response(body)
      }
      return new Response("nope", { status: 404 })
    }),
  )
})
afterAll(() => {
  vi.unstubAllGlobals()
  meta.close()
  rmSync(dir, { recursive: true, force: true })
})

const mkSource = async (repo: string): Promise<RepoSourceRecord> => {
  const col = await meta.createCollection({
    id: newId("col"),
    org_id: "default",
    title: repo,
    created_by: "u",
  })
  return meta.createRepoSource({
    id: newId("rs"),
    org_id: "default",
    collection_id: col.id,
    repo,
    ref: "main",
    includes: "**/*.md",
    created_by: "u",
  })
}

describe("GitHub author tracking — sync capture", () => {
  it("stamps the commit author on both the version and the artifact", async () => {
    const src = await mkSource("acme/repo-a")
    tree = [{ path: "intro.md", sha: "sha-a-1", type: "blob" }]
    blobs["sha-a-1"] = "# Intro"
    commits["intro.md"] = {
      commit: {
        committer: { date: "2025-05-05T05:05:05Z" },
        author: { name: "Ada Lovelace", email: "ada@example.com" },
      },
      author: { login: "ada", id: 4242, avatar_url: "https://avatars/ada.png" },
    }

    await runSync(meta, blobStore, src, NOW)

    const map = JSON.parse((await meta.getRepoSource(src.id))?.files ?? "{}") as Record<
      string,
      { artifact_id: string; short_id: string; authorSourced?: boolean; updatedAt?: string }
    >
    const ent = map["intro.md"]
    expect(ent?.authorSourced).toBe(true)
    expect(ent?.updatedAt).toBe("2025-05-05T05:05:05Z")

    // Artifact: denormalized current author + date.
    const art = await meta.getByShortId(ent?.short_id ?? "")
    expect(art?.author_name).toBe("ada") // display name prefers the login
    expect(art?.author_login).toBe("ada")
    expect(art?.author_gh_id).toBe("4242")
    expect(art?.author_avatar).toBe("https://avatars/ada.png")
    expect(art?.updated_at).toBe("2025-05-05T05:05:05Z")

    // Version row: the GitHub identity is stored per-version too.
    const v = await meta.getVersion(art?.id ?? "", 1)
    expect(v?.author).toBe("ada")
    expect(v?.author_login).toBe("ada")
    expect(v?.author_gh_id).toBe("4242")
  })

  it("falls back to the git author name (then 'GitHub sync') when GitHub maps no account", async () => {
    const src = await mkSource("acme/repo-b")
    tree = [
      { path: "named.md", sha: "sha-b-1", type: "blob" },
      { path: "bare.md", sha: "sha-b-2", type: "blob" },
    ]
    blobs["sha-b-1"] = "# Named"
    blobs["sha-b-2"] = "# Bare"
    // A commit with a git author name but no resolved GitHub account.
    commits["named.md"] = {
      commit: {
        committer: { date: "2024-02-02T02:02:02Z" },
        author: { name: "Grace Hopper", email: "grace@example.com" },
      },
      author: null,
    }
    // No identity at all → keep the legacy "GitHub sync" display name.
    commits["bare.md"] = { commit: { committer: { date: "2024-03-03T03:03:03Z" } } }

    await runSync(meta, blobStore, src, NOW)
    const map = JSON.parse((await meta.getRepoSource(src.id))?.files ?? "{}") as Record<
      string,
      { short_id: string }
    >

    const named = await meta.getByShortId(map["named.md"]?.short_id ?? "")
    expect(named?.author_name).toBe("Grace Hopper")
    expect(named?.author_login).toBeNull()
    expect(named?.author_gh_id).toBeNull()

    const bare = await meta.getByShortId(map["bare.md"]?.short_id ?? "")
    expect(bare?.author_name).toBe("GitHub sync")
    expect(bare?.author_login).toBeNull()
  })
})

describe("GitHub author tracking — model + list filter", () => {
  it("artifactIdsByAuthor filters by login (case-insensitive), scoped to the org", async () => {
    // Two artifacts authored by "ada" already exist from repo-a; publish one by another
    // login + one in another org to prove scoping + login matching.
    const other = await meta.createArtifact({
      id: newId("a"),
      short_id: newId("s"),
      org_id: "default",
      slug: null,
      title: "by-bob",
      workspace_access: "member",
      link_role: "viewer",
      listed: "public",
      kind: "file",
      spa: 0,
    })
    await meta.addVersion(other.id, {
      id: newId("v"),
      blob_key: await blobStore.put(new TextEncoder().encode("x")),
      content_type: "text/markdown",
      size_bytes: 1,
      author: "bob",
      author_login: "bob",
      author_avatar: null,
      author_gh_id: "9001",
      message: null,
    })

    const ada = await meta.artifactIdsByAuthor("default", "ADA") // case-insensitive
    expect(ada.length).toBe(1)
    const bob = await meta.artifactIdsByAuthor("default", "bob")
    expect(bob).toEqual([other.id])
    expect(await meta.artifactIdsByAuthor("default", "nobody")).toEqual([])
    expect(await meta.artifactIdsByAuthor("other-org", "ada")).toEqual([])
  })

  it("?author= narrows the artifact list", async () => {
    const all = await (await app.request("/v1/artifacts?limit=100", { headers: auth })).json()
    const byBob = await (
      await app.request("/v1/artifacts?author=bob&limit=100", { headers: auth })
    ).json()
    expect(all.artifacts.length).toBeGreaterThan(byBob.artifacts.length)
    expect(
      byBob.artifacts.every((a: { author_login: string | null }) => a.author_login === "bob"),
    ).toBe(true)
    // The list carries the denormalized author fields for the UI.
    expect(byBob.artifacts[0].author_name).toBe("bob")
    expect(byBob.artifacts[0].author).toMatchObject({ login: "bob", name: "bob" })
  })
})

describe("GitHub author tracking — user mapping", () => {
  it("usersByGithubIds maps an account row to its Derive user", async () => {
    // Seed Better Auth's user + account tables directly via the raw sqlite handle.
    const raw = new Database(dbPath)
    raw.exec(
      `CREATE TABLE IF NOT EXISTS user (id TEXT PRIMARY KEY, email TEXT, name TEXT, image TEXT, username TEXT, discoverable INTEGER, profession TEXT, about TEXT)`,
    )
    raw.exec(
      `CREATE TABLE IF NOT EXISTS account (id TEXT PRIMARY KEY, accountId TEXT, providerId TEXT, userId TEXT)`,
    )
    raw
      .prepare(`INSERT OR IGNORE INTO user (id, name, image, username) VALUES (?,?,?,?)`)
      .run("u-ada", "Ada L.", "https://img/ada", "ada-handle")
    raw
      .prepare(`INSERT OR IGNORE INTO account (id, accountId, providerId, userId) VALUES (?,?,?,?)`)
      .run("acc-1", "4242", "github", "u-ada")
    raw.close()

    const rows = await meta.usersByGithubIds(["4242", "9999"])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      gh_id: "4242",
      id: "u-ada",
      username: "ada-handle",
      name: "Ada L.",
      image: "https://img/ada",
    })

    // The single-artifact API resolves the handle onto the author profile.
    const ada = (await meta.artifactIdsByAuthor("default", "ada"))[0] as string
    const art = await meta.getArtifactById(ada)
    const detail = await (
      await app.request(`/v1/artifacts/${art?.short_id}`, { headers: auth })
    ).json()
    expect(detail.author).toMatchObject({ login: "ada", handle: "ada-handle" })
    expect(detail.versions[0]).toMatchObject({ author_login: "ada", handle: "ada-handle" })
  })

  it("returns [] for empty input or when the tables are absent", async () => {
    expect(await meta.usersByGithubIds([])).toEqual([])
    // A fresh store with no user/account tables resolves gracefully to [].
    const m2 = new SqliteMetaStore(join(dir, "empty.db"))
    expect(await m2.usersByGithubIds(["1"])).toEqual([])
    m2.close()
  })
})

describe("self-healing bylines — a stale byline resolves to the live user", () => {
  it("an old version frozen as 'Derive CLI' reads as its author_id user on read", async () => {
    // A Derive account exists (Better Auth's user table).
    const raw = new Database(dbPath)
    raw.exec(
      `CREATE TABLE IF NOT EXISTS user (id TEXT PRIMARY KEY, email TEXT, name TEXT, image TEXT, username TEXT, discoverable INTEGER, profession TEXT, about TEXT)`,
    )
    raw
      .prepare(`INSERT OR IGNORE INTO user (id, email, name, username) VALUES (?,?,?,?)`)
      .run("u_cli", "anir@x.test", "Anir Agarwal", "anir")
    raw.close()

    // Simulate a pre-fix CLI publish: the byline string is frozen as the OAuth client name,
    // but author_id already points at the human (what makes it show under "created by me").
    const art = await meta.createArtifact({
      id: newId("a"),
      short_id: newId("s"),
      org_id: "default",
      slug: null,
      title: "CLI doc",
      visibility: "public",
      kind: "file",
      spa: 0,
    })
    await meta.addVersion(art.id, {
      id: newId("v"),
      blob_key: await blobStore.put(new TextEncoder().encode("<h1>x</h1>")),
      content_type: "text/html",
      size_bytes: 1,
      author: "Derive CLI", // the stale frozen byline
      author_id: "u_cli", // the truth — denormalized onto the artifact too
      message: null,
    })

    const detail = await (
      await app.request(`/v1/artifacts/${art.short_id}`, { headers: auth })
    ).json()
    // Both the version byline and the current-author profile heal to the live user.
    expect(detail.versions[0].author).toBe("Anir Agarwal")
    expect(detail.versions[0].handle).toBe("anir")
    expect(detail.author).toMatchObject({ name: "Anir Agarwal", handle: "anir" })

    // And the list view heals the same way (no stale name on the card).
    const list = await (await app.request("/v1/artifacts?limit=100", { headers: auth })).json()
    const row = list.artifacts.find((a: { short_id: string }) => a.short_id === art.short_id)
    expect(row.author).toMatchObject({ name: "Anir Agarwal", handle: "anir" })
  })
})
