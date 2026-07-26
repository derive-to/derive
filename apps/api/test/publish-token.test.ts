import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { newId } from "@derive/core"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { FsBlobStore } from "@derive/storage/fs"
import Database from "better-sqlite3"
import { afterAll, describe, expect, it } from "vitest"
import { createApp } from "../src/app"
import { zipBundleFiles } from "../src/lib/bundle"
import { signCapabilityToken } from "../src/lib/capability-token"
import {
  PUBLISH_TARGET_CREATE,
  signPublishToken,
  verifyPublishToken,
} from "../src/lib/publish-token"

// ---- Unit tests: token sign/verify -----------------------------------------

describe("publish token", () => {
  const secret = "s3cr3t-long-enough" // gitleaks:allow

  it("round-trips a create token", async () => {
    const tok = await signPublishToken(secret, "ws_a", "u_1", PUBLISH_TARGET_CREATE, 10_000)
    expect(await verifyPublishToken(secret, tok, 5_000)).toEqual({
      orgId: "ws_a",
      userId: "u_1",
      target: "*",
    })
  })

  it("round-trips a revise token (target = short_id)", async () => {
    const tok = await signPublishToken(secret, "ws_a", "u_1", "lp5e8s04", 10_000)
    expect(await verifyPublishToken(secret, tok, 5_000)).toEqual({
      orgId: "ws_a",
      userId: "u_1",
      target: "lp5e8s04",
    })
  })

  it("returns null after expiry", async () => {
    const tok = await signPublishToken(secret, "ws_a", "u_1", "*", 10_000)
    expect(await verifyPublishToken(secret, tok, 20_000)).toBeNull()
  })

  it("returns null when tampered or signed with another secret", async () => {
    const tok = await signPublishToken(secret, "ws_a", "u_1", "*", 10_000)
    expect(await verifyPublishToken(secret, `${tok}x`, 5_000)).toBeNull()
    expect(await verifyPublishToken("other", tok, 5_000)).toBeNull()
  })

  it("is domain-separated: a token from another kind won't verify here", async () => {
    // Same secret, same payload bytes, different DOMAIN — the domain is part of
    // the key, so an upload-domain token must be rejected by the publish verifier
    // (and vice versa). This is what stops one capability being replayed as another.
    const foreign = await signCapabilityToken(
      "derive-upload-token:",
      secret,
      ["ws_a", "u_1", "*"],
      10_000,
    )
    expect(await verifyPublishToken(secret, foreign, 5_000)).toBeNull()
  })
})

// ---- Route tests: /v1/artifacts/t/:token (MCP-minted publish URL) ----------

const dir = mkdtempSync(join(tmpdir(), "derive-pubtoken-"))
const SECRET = "test-publish-secret-long-enough"
const path = join(dir, "pub.db")
const meta = new SqliteMetaStore(path)
const blobs = new FsBlobStore(join(dir, "blobs"))

// Seed the granting user (Better Auth `user` table) + an editor membership so the
// spend-time recheck passes and getUsers resolves a byline.
const raw = new Database(path)
raw.exec(
  `CREATE TABLE IF NOT EXISTS user (id TEXT PRIMARY KEY, email TEXT, name TEXT, image TEXT, username TEXT, discoverable INTEGER, profession TEXT, about TEXT, onboarded INTEGER, brandprint TEXT)`,
)
const insUser = raw.prepare(`INSERT OR IGNORE INTO user (id,email,name) VALUES (?,?,?)`)
insUser.run("u_pub", "pub@x.test", "Pub User")
insUser.run("u_viewer", "viewer@x.test", "Viewer User")
insUser.run("u_noname", "noname@x.test", null) // null byline — spoofing regression
raw.close()

const app = createApp({
  meta,
  blobs,
  baseUrl: "http://derive.test",
  token: "tok",
  encryptionKey: SECRET,
})

afterAll(() => {
  meta.close()
  rmSync(dir, { recursive: true, force: true })
})

const seatUser = async (role: "editor" | "commenter", org = "default") =>
  meta.setMembership({ id: newId("m"), org_id: org, user_id: "u_pub", role })

// Multipart publish with NO auth header — the token in the URL is the only proof.
const postFile = (
  url: string,
  bytes: Uint8Array,
  name: string,
  type: string,
  fields: Record<string, string> = {},
) => {
  const fd = new FormData()
  fd.append("file", new File([bytes as BlobPart], name, { type }), name)
  for (const [k, v] of Object.entries(fields)) fd.append(k, v)
  return app.request(url, { method: "POST", body: fd })
}

const html = (s: string) => new TextEncoder().encode(s)
const createTok = (exp = Date.now() + 60_000, org = "default") =>
  signPublishToken(SECRET, org, "u_pub", PUBLISH_TARGET_CREATE, exp)

describe("POST /v1/artifacts/t/:token (create)", () => {
  it("setup: seat the granting user as an editor", async () => {
    await seatUser("editor")
  })

  it("publishes a single file with no auth header, owned + attributed to the bound user", async () => {
    const tok = await createTok()
    const res = await postFile(
      `/v1/artifacts/t/${tok}`,
      html("<h1>Big Page</h1>"),
      "page.html",
      "text/html",
      { title: "Big Page" },
    )
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.short_id).toBeTruthy()
    expect(body.published).toBe(1)

    // Attribution: the artifact is owned by the bound user (this is what makes
    // `private` work + lets them find their own work), and the version byline is
    // their name — not anonymous, even though the request carried no session.
    const art = await meta.getByShortId(body.short_id)
    if (!art) throw new Error("expected the created artifact")
    expect(await meta.getArtifactMember(art.id, "u_pub")).toBeTruthy()
    const v = await meta.getVersion(art.id, 1)
    expect(v?.author).toBe("Pub User")
    expect(art.org_id).toBe("default")
  })

  it("publishes a zip as a multi-page bundle", async () => {
    const tok = await createTok()
    const zip = await zipBundleFiles({
      "index.html": "<!doctype html><h1>Site</h1><a href=about.html>about</a>",
      "about.html": "<!doctype html><h1>About</h1>",
    })
    const res = await postFile(`/v1/artifacts/t/${tok}`, zip, "site.zip", "application/zip", {
      title: "Prototype",
    })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.kind).toBe("bundle")
  })

  it("a create token cannot be used on the revise route (target mismatch)", async () => {
    const tok = await createTok()
    // First make an artifact to aim at.
    const made = await (
      await postFile(
        `/v1/artifacts/t/${await createTok()}`,
        html("<h1>x</h1>"),
        "x.html",
        "text/html",
      )
    ).json()
    const res = await postFile(
      `/v1/artifacts/${made.short_id}/versions/t/${tok}`,
      html("<h1>y</h1>"),
      "y.html",
      "text/html",
    )
    expect(res.status).toBe(403)
  })

  it("expired / garbage tokens → 403", async () => {
    const expired = await createTok(Date.now() - 1_000)
    expect(
      (await postFile(`/v1/artifacts/t/${expired}`, html("<h1>x</h1>"), "x.html", "text/html"))
        .status,
    ).toBe(403)
    expect(
      (await postFile(`/v1/artifacts/t/garbage`, html("<h1>x</h1>"), "x.html", "text/html")).status,
    ).toBe(403)
  })

  it("a server with no signing secret refuses the tokened route", async () => {
    const noSecret = createApp({
      meta: new SqliteMetaStore(join(dir, "nosecret.db")),
      blobs: new FsBlobStore(join(dir, "nosecret-blobs")),
      baseUrl: "http://derive.test",
      token: "tok",
    })
    const tok = await createTok()
    const res = await noSecret.request(`/v1/artifacts/t/${tok}`, {
      method: "POST",
      body: (() => {
        const fd = new FormData()
        fd.append(
          "file",
          new File([html("<h1>x</h1>") as BlobPart], "x.html", { type: "text/html" }),
          "x.html",
        )
        return fd
      })(),
    })
    expect(res.status).toBe(403)
  })
})

describe("POST /v1/artifacts/:shortId/versions/t/:token (revise)", () => {
  let shortId: string

  it("setup: create an artifact to revise", async () => {
    await seatUser("editor")
    const made = await (
      await postFile(
        `/v1/artifacts/t/${await createTok()}`,
        html("<h1>v1</h1>"),
        "a.html",
        "text/html",
      )
    ).json()
    shortId = made.short_id
  })

  it("a revise token publishes a new version of exactly its target", async () => {
    const tok = await signPublishToken(SECRET, "default", "u_pub", shortId, Date.now() + 60_000)
    const res = await postFile(
      `/v1/artifacts/${shortId}/versions/t/${tok}`,
      html("<h1>v2</h1>"),
      "a.html",
      "text/html",
    )
    expect(res.status).toBe(201)
    expect((await res.json()).published).toBe(2)
  })

  it("a revise token for artifact X cannot publish to artifact Y", async () => {
    const other = await (
      await postFile(
        `/v1/artifacts/t/${await createTok()}`,
        html("<h1>other</h1>"),
        "b.html",
        "text/html",
      )
    ).json()
    const tokForShortId = await signPublishToken(
      SECRET,
      "default",
      "u_pub",
      shortId,
      Date.now() + 60_000,
    )
    const res = await postFile(
      `/v1/artifacts/${other.short_id}/versions/t/${tokForShortId}`,
      html("<h1>hijack</h1>"),
      "b.html",
      "text/html",
    )
    expect(res.status).toBe(403)
  })

  it("a revise token cannot reach an artifact in a different workspace than the token's org", async () => {
    // Artifact lives in orgB; the token is scoped to "default". Membership
    // re-check passes (u_pub IS a default editor), but the cross-org guard in
    // handlePublish refuses — a token for one workspace can't touch another's.
    const foreign = await meta.createArtifact({
      id: newId("a"),
      short_id: "foreign1",
      org_id: "orgB",
      slug: null,
      title: "Foreign",
      workspace_access: "member",
      link_role: "none",
      listed: "none",
      kind: "file",
      spa: 0,
    })
    await meta.addVersion(foreign.id, {
      id: newId("v"),
      blob_key: await blobs.put(html("<h1>foreign</h1>")),
      content_type: "text/html",
      size_bytes: 10,
      author: "t",
      message: null,
    })
    const tok = await signPublishToken(SECRET, "default", "u_pub", "foreign1", Date.now() + 60_000)
    const res = await postFile(
      `/v1/artifacts/foreign1/versions/t/${tok}`,
      html("<h1>x</h1>"),
      "x.html",
      "text/html",
    )
    expect(res.status).toBe(403)
  })

  it("revocation mid-TTL: losing the seat that granted publish kills an outstanding token", async () => {
    await seatUser("editor")
    // An artifact u_pub does NOT own (created directly, no owner share) that is
    // workspace-accessible — so u_pub's publish right comes purely from the editor
    // SEAT. Demoting the seat must kill an outstanding revise token, live. (On an
    // artifact they own, the owner share persists past a seat change — correct, and
    // why this uses a seat-only artifact.)
    const seatArt = await meta.createArtifact({
      id: newId("a"),
      short_id: "seatart1",
      org_id: "default",
      slug: null,
      title: "Seat-only",
      workspace_access: "member",
      link_role: "none",
      listed: "none",
      kind: "file",
      spa: 0,
    })
    await meta.addVersion(seatArt.id, {
      id: newId("v"),
      blob_key: await blobs.put(html("<h1>v1</h1>")),
      content_type: "text/html",
      size_bytes: 10,
      author: "t",
      message: null,
    })
    const tok = await signPublishToken(SECRET, "default", "u_pub", "seatart1", Date.now() + 60_000)
    // Editor seat → works.
    expect(
      (
        await postFile(
          `/v1/artifacts/seatart1/versions/t/${tok}`,
          html("<h1>v2</h1>"),
          "a.html",
          "text/html",
        )
      ).status,
    ).toBe(201)
    // Demote to commenter → the SAME unexpired token is now refused.
    await seatUser("commenter")
    expect(
      (
        await postFile(
          `/v1/artifacts/seatart1/versions/t/${tok}`,
          html("<h1>v3</h1>"),
          "a.html",
          "text/html",
        )
      ).status,
    ).toBe(403)
    await seatUser("editor") // restore for any later test
  })

  it("a token whose user isn't a member → 403", async () => {
    const tok = await signPublishToken(SECRET, "default", "u_ghost", shortId, Date.now() + 60_000)
    const res = await postFile(
      `/v1/artifacts/${shortId}/versions/t/${tok}`,
      html("<h1>x</h1>"),
      "a.html",
      "text/html",
    )
    expect(res.status).toBe(403)
  })

  it("no escalation: a workspace editor with only a viewer share can't revise a PRIVATE artifact", async () => {
    // The token path must re-check ARTIFACT-level standing, not the workspace seat.
    // On a private artifact (workspace_access="none") the seat grants nothing — only
    // the share counts — so a workspace editor holding a mere viewer share is refused,
    // exactly as the authed API refuses them.
    await seatUser("editor") // u_pub, the creator/owner
    await meta.setMembership({
      id: newId("m"),
      org_id: "default",
      user_id: "u_viewer",
      role: "editor",
    })
    const priv = await (
      await postFile(
        `/v1/artifacts/t/${await createTok()}`,
        html("<h1>secret</h1>"),
        "s.html",
        "text/html",
        {
          workspace_access: "none",
        },
      )
    ).json()
    const art = await meta.getByShortId(priv.short_id)
    if (!art) throw new Error("expected the private artifact")
    await meta.setArtifactMember({
      id: newId("am"),
      artifact_id: art.id,
      user_id: "u_viewer",
      role: "viewer",
    })

    // Workspace editor + viewer share → refused.
    const viewerTok = await signPublishToken(
      SECRET,
      "default",
      "u_viewer",
      priv.short_id,
      Date.now() + 60_000,
    )
    expect(
      (
        await postFile(
          `/v1/artifacts/${priv.short_id}/versions/t/${viewerTok}`,
          html("<h1>hijack</h1>"),
          "s.html",
          "text/html",
        )
      ).status,
    ).toBe(403)

    // The owner (real publish standing on the private artifact) still can.
    const ownerTok = await signPublishToken(
      SECRET,
      "default",
      "u_pub",
      priv.short_id,
      Date.now() + 60_000,
    )
    expect(
      (
        await postFile(
          `/v1/artifacts/${priv.short_id}/versions/t/${ownerTok}`,
          html("<h1>v2</h1>"),
          "s.html",
          "text/html",
        )
      ).status,
    ).toBe(201)
  })

  it("never takes the client-supplied author byline (bound to the real user)", async () => {
    // A user whose stored name is null must not let the curl caller stamp an
    // arbitrary `author` field as the version byline.
    await meta.setMembership({
      id: newId("m"),
      org_id: "default",
      user_id: "u_noname",
      role: "editor",
    })
    const tok = await signPublishToken(
      SECRET,
      "default",
      "u_noname",
      PUBLISH_TARGET_CREATE,
      Date.now() + 60_000,
    )
    const res = await postFile(
      `/v1/artifacts/t/${tok}`,
      html("<h1>x</h1>"),
      "x.html",
      "text/html",
      {
        author: "Impersonated",
      },
    )
    expect(res.status).toBe(201)
    const art = await meta.getByShortId((await res.json()).short_id)
    if (!art) throw new Error("expected the artifact")
    const v = await meta.getVersion(art.id, 1)
    expect(v?.author).not.toBe("Impersonated")
  })
})
