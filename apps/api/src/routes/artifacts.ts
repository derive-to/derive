import {
  type ArtifactRecord,
  type BundleDoc,
  type BundleManifest,
  bundleDoc,
  can,
  diffLines,
  effectiveRole,
  formatDiff,
  groupSessions,
  isMarkdownBundle,
  newId,
  PublishError,
  publish,
  renderMarkdown,
  toJson,
} from "@derive/core"
import { type Context, Hono } from "hono"
import { setCookie } from "hono/cookie"
import { z } from "zod"
import type { AppContext } from "../context"
import { sweepAnchors } from "../lib/anchor-sweep"
import { authorProfile, resolveHandles } from "../lib/author"
import { hashPassword, safeEqual, unlockCookie, unlockToken, verifyPassword } from "../lib/crypto"
import {
  DEFAULT_WORKSPACE_NAME,
  fail,
  MAX_UPLOAD_BYTES,
  readJson,
  str,
  TOMBSTONE,
  visibilityOf,
} from "../lib/http"

/** The artifact lifecycle: browse + summary, publish/republish, detail, restore,
 *  source read-back, and version diffs. */
export const artifactRoutes = (ctx: AppContext) => {
  const {
    meta,
    blobs,
    deps,
    analyticsOn,
    versionWindowMs,
    bus,
    notify,
    background,
    bearer,
    currentUser,
    actingUser,
    activeWorkspace,
    actorFor,
    authorize,
    workspaceCan,
    collectionRole,
    limited,
    overStorage,
    publishLimiter,
    unlockLimiter,
    sourceText,
  } = ctx
  const app = new Hono()

  // Newest-first, keyset-paginated (?cursor=<created_at>&limit=N), with optional
  // server-side ?query= (title search), ?tag=, and ?favorite=true. Returns
  // { artifacts, next_cursor }. tag/favorite resolve to an id set first.
  app.get("/v1/artifacts", async (c) => {
    const me = await currentUser(c)
    if (!me && deps.token && !safeEqual(bearer(c), deps.token))
      return fail(c, 401, "unauthenticated")
    const limit = Math.min(100, Math.max(1, Number(c.req.query("limit")) || 30))
    // Opaque compound cursor "<created_at>|<id>" — the id tiebreak keeps paging
    // correct when many artifacts share a created_at.
    const rawCursor = c.req.query("cursor")
    const sep = rawCursor?.indexOf("|") ?? -1
    const cursor =
      rawCursor && sep > 0
        ? { created_at: rawCursor.slice(0, sep), id: rawCursor.slice(sep + 1) }
        : undefined
    // Cap the search term: it goes into a SQL LIKE, and an oversized value tripped
    // an unhandled DB error (a long-q 500). No real title search needs > 200 chars.
    const q = c.req.query("query")?.trim().slice(0, 200) || undefined
    const tag = c.req.query("tag")?.trim() || undefined
    const collectionId = c.req.query("collection")?.trim() || undefined
    const favOnly = c.req.query("favorite") === "true"
    // ?author=<github login> narrows to artifacts whose current author is that login.
    const author = c.req.query("author")?.trim().slice(0, 100) || undefined

    const favIds = me ? await meta.listUserFavoriteIds(me.id) : []
    const favorites = new Set(favIds)
    // tag / collection / favorite each narrow to an id set; intersect when combined.
    let ids: string[] | undefined
    const narrow = (next: string[]) => {
      ids = ids ? ids.filter((id) => next.includes(id)) : next
    }
    // scope=shared → artifacts explicitly shared with me (a per-artifact membership),
    // which can live in other workspaces. Drives the home's "Shared with you" section.
    const shared = c.req.query("scope") === "shared"
    if (shared) {
      if (!me) return c.json({ artifacts: [], next_cursor: null })
      narrow(await meta.artifactIdsSharedWith(me.id))
    }
    // scope=following → artifacts in the active workspace whose current author or repo
    // path matches one of my follows (authors + path prefixes). The activity feed.
    const following = c.req.query("scope") === "following"
    if (following) {
      if (!me) return c.json({ artifacts: [], next_cursor: null })
      narrow(await meta.followedArtifactIds(me.id, await activeWorkspace(c)))
    }
    // scope=needs_feedback → artifacts in the active workspace with an open thread you're
    // tagged in or have commented on. Drives the home's "Needs your feedback" section.
    const needsFeedback = c.req.query("scope") === "needs_feedback"
    if (needsFeedback) {
      if (!me) return c.json({ artifacts: [], next_cursor: null })
      narrow(await meta.artifactIdsNeedingFeedback(me.id, await activeWorkspace(c)))
    }
    if (tag) narrow(await meta.artifactIdsByTag(tag))
    if (favOnly) narrow(favIds)

    // A collection's artifacts live in the COLLECTION's workspace, not necessarily
    // your active one — so scope the listing to the collection's org (gated by
    // access), or a direct/cold link to a collection in another workspace reads as
    // empty. Unknown collection ⇒ nothing.
    let listOrg = await activeWorkspace(c)
    let collectionAccess = false
    // Carry the collection's title so the client can label the view even when the
    // collection lives in another workspace (it's absent from the local sidebar list).
    let collectionInfo: { id: string; title: string } | undefined
    if (collectionId) {
      const col = await meta.getCollection(collectionId)
      if (!col) return c.json({ artifacts: [], next_cursor: null })
      // Scope to the collection via a JOIN in listArtifacts (below), NOT by expanding
      // its members into an id IN(): a large collection (hundreds of items) would blow
      // D1's 100-bound-parameter cap and 500 the whole listing.
      listOrg = col.org_id
      collectionInfo = { id: col.id, title: col.title }
      collectionAccess =
        (deps.token && safeEqual(bearer(c), deps.token)) ||
        (!!me && !!(await meta.getMembership(col.org_id, me.id))) ||
        (await collectionRole(c, col)) !== null
    }
    // Author filter narrows to artifacts last changed by a GitHub login, scoped to the
    // listing's workspace (after collection scope has settled listOrg). Mirrors ?tag=.
    if (author) narrow(await meta.artifactIdsByAuthor(listOrg, author))
    if (ids && ids.length === 0) return c.json({ artifacts: [], next_cursor: null })

    // The caller's baseline standing in the listing's workspace — reused for the
    // public-only clamp below and the per-row `my_role`.
    const isOperator = !!(deps.token && safeEqual(bearer(c), deps.token))
    const myMembership = me ? await meta.getMembership(listOrg, me.id) : null
    // A listing only shows non-public artifacts to a MEMBER of that workspace (or the
    // operator token). Anyone else — anonymous, or a signed-in user who isn't a member
    // — sees public artifacts only, so org/link titles never leak via the list or ?query=.
    // For a collection, collection access (member/creator/share) also unlocks it.
    const publicOnly = collectionId ? !collectionAccess : !(isOperator || !!myMembership)
    const rows = await meta.listArtifacts({
      limit: limit + 1,
      cursor,
      q,
      ids,
      collectionId,
      // `shared` and `following` both resolve to an id set that ALREADY encodes the
      // correct cross-workspace + visibility scope (an explicit share; or a followed
      // author/path in this workspace + a followed person's public work anywhere). So
      // drop the workspace + public-only restrictions, which would otherwise re-clip the
      // feed back to the active workspace and strip a followed person's public work.
      orgId: shared || following ? undefined : listOrg,
      publicOnly: shared || following ? false : publicOnly,
      // Private artifacts appear only for their explicit members; the operator
      // token sees everything (viewerId omitted).
      viewerId: isOperator ? undefined : (me?.id ?? undefined),
    })
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const last = page[page.length - 1]
    const next_cursor = hasMore && last ? `${last.created_at}|${last.id}` : null

    const pageIds = page.map((a) => a.id)
    const counts = analyticsOn ? await meta.viewCounts(pageIds) : {}
    const tags = await meta.tagsForArtifacts(pageIds)
    // Resolve the page's distinct author gh_ids to Derive handles in ONE batched query (no
    // N+1) so each row can show "who last changed this" with a link to the Derive profile.
    const handleByGhId = await resolveHandles(meta, [
      ...new Set(page.map((a) => a.author_gh_id).filter((x): x is string => !!x)),
    ])
    // Per-artifact comment signals for the viewer (open-thread count + tagged/authored
    // flags) — drives the inline comment badge and the "needs your feedback" featuring.
    const feedback = me ? await meta.commentSignals(pageIds, me.id) : {}
    // The viewer's per-artifact shares across the page, one query — folded into
    // my_role below so shared and private rows gate their quick actions correctly.
    const shareRoles = me ? await meta.artifactRolesFor(me.id, pageIds) : {}
    return c.json({
      artifacts: page.map((a) => ({
        ...toJson(deps.baseUrl, a, []),
        views: counts[a.id] ?? 0,
        tags: tags[a.id] ?? [],
        favorite: favorites.has(a.id),
        // Which actions the client may surface on the row (the card's quick-actions
        // menu gates delete/tags on it). Workspace membership + per-artifact shares
        // + the general-access floor; collection-share roles aren't folded in at
        // list granularity, so the detail response's my_role stays authoritative.
        my_role: isOperator
          ? "owner"
          : effectiveRole(
              me
                ? {
                    kind: "user",
                    userId: me.id,
                    artifactRole: shareRoles[a.id] ?? null,
                    orgRole: a.org_id === listOrg ? (myMembership?.role ?? null) : null,
                  }
                : { kind: "anon" },
              a.visibility,
              a.general_role,
            ),
        // The current author as a resolved profile (name/login/avatar + Derive handle), so
        // the list can render the last editor + filter by them.
        author: authorProfile(a, handleByGhId),
        // open_threads + mentions_me + i_participated (defaults for anon / no signals).
        ...(feedback[a.id] ?? { open_threads: 0, mentions_me: false, i_participated: false }),
      })),
      next_cursor,
      ...(collectionInfo ? { collection: collectionInfo } : {}),
    })
  })

  // Browse summary for the sidebar: total artifacts, this user's favorite count,
  // and tag → count (so counts stay accurate independent of the current page).
  app.get("/v1/tags", async (c) => {
    const me = await currentUser(c)
    if (!me && deps.token && !safeEqual(bearer(c), deps.token))
      return fail(c, 401, "unauthenticated")
    const org = await activeWorkspace(c)
    // The sidebar summary (workspace name, total artifact count, tag breakdown) is a
    // member view. A non-member — including an anonymous caller in open mode — gets an
    // empty summary with no workspace name, so it can't be used to enumerate a private
    // workspace's name + size.
    const isMember =
      (deps.token && safeEqual(bearer(c), deps.token)) ||
      (!!me && !!(await meta.getMembership(org, me.id)))
    if (!isMember) return c.json({ total: 0, favorites: 0, tags: [], workspace: null })
    const [total, tags, favIds, ws] = await Promise.all([
      meta.countArtifacts(org),
      meta.tagCounts(org),
      // Scope the favorites count to THIS workspace's live artifacts — the favorites
      // view is workspace-scoped, so a favorite of an artifact in another workspace
      // must not inflate the count (otherwise "Favorites · 1" with an empty list).
      me ? meta.listUserFavoriteIds(me.id, org) : Promise.resolve([]),
      meta.getWorkspace(org),
    ])
    tags.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
    return c.json({
      total,
      favorites: favIds.length,
      tags,
      workspace: ws?.name ?? DEFAULT_WORKSPACE_NAME,
    })
  })

  // ---- Publish ----------------------------------------------------------

  const handlePublish = async (c: Context, shortId?: string) => {
    // Republishing a version needs publish rights on that artifact; creating a
    // new one needs publish rights at the workspace level.
    let existing: ArtifactRecord | null = null
    if (shortId) {
      existing = await meta.getByShortId(shortId)
      if (!existing) return fail(c, 404, "not found")
      if (!(await authorize(c, "publish", existing))) return fail(c, 403, "forbidden")
      // A GitHub-synced artifact is read-only in Derive: GitHub is the source of
      // truth, so a republish would be silently overwritten on the next sync.
      // Edit it in the repo instead.
      if ((await meta.managedArtifactIds(existing.org_id)).includes(existing.id))
        return fail(c, 409, "managed by GitHub sync — edit this file in the repo")
      // Locked: even an editor can't publish directly — changes go through review.
      // The web client routes editors to "propose" when locked, so this is the
      // backstop (and the answer for API/CLI callers).
      if (existing.locked) return fail(c, 409, "artifact is locked — propose a change for review")
    } else if (!(await workspaceCan(c, "publish"))) {
      return fail(c, 403, "forbidden")
    }
    // Quotas are per-workspace: a republish counts against the artifact's own
    // org, a new artifact against the caller's active workspace.
    const org = existing ? existing.org_id : await activeWorkspace(c)
    const rl = await limited(c, publishLimiter)
    if (rl) return rl
    // A new artifact counts against the artifact cap; republishes don't.
    if (!shortId && deps.maxArtifacts && (await meta.countArtifacts(org)) >= deps.maxArtifacts)
      return fail(c, 409, "artifact quota reached")
    const len = Number(c.req.header("content-length") ?? 0)
    if (len > MAX_UPLOAD_BYTES) return fail(c, 413, "upload too large")

    const body = await c.req.parseBody()
    const file = body["file"]
    if (!(file instanceof File)) return fail(c, 400, "multipart field 'file' required")

    const bytes = new Uint8Array(await file.arrayBuffer())
    // The content-length header is advisory (a client can omit/understate it),
    // so re-check the actual buffered size — the hard cap before anything stores.
    if (bytes.length > MAX_UPLOAD_BYTES) return fail(c, 413, "upload too large")
    if (await overStorage(org, bytes.length)) return fail(c, 413, "storage quota exceeded")
    const isBundle =
      /\.zip$/i.test(file.name) ||
      body["kind"] === "bundle" ||
      (bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 3 || bytes[2] === 5))

    // `password` visibility on a NEW artifact must carry a password to hash; a
    // republish keeps whatever the artifact already has (publish() never re-creates
    // the artifact, only adds a version, so visibility/password are set-on-create).
    const visibility = visibilityOf(body["visibility"])
    // An explicitly-provided visibility that isn't a known value is rejected, not
    // silently coerced — a typo must not publish more openly than intended.
    if (str(body["visibility"]) && !visibility)
      return fail(c, 400, "visibility must be one of: public, link, org, password, private")
    const password = str(body["password"])
    if (!shortId && visibility === "password" && !password)
      return fail(c, 400, "a password is required for password visibility")
    const passwordHash = visibility === "password" && password ? hashPassword(password) : undefined

    try {
      // The authenticated principal behind this publish (signed-in user or agent) — its
      // `name` is the display author. The Derive-USER behind it (null for an agent / bare
      // static token) is what we attribute work to: `author_id` keys a person's profile
      // + their followers' feed, so it must be a real user id, never an agent principal.
      const actor = await actingUser(c)
      const user = await currentUser(c)
      const { artifact, version } = await publish(
        meta,
        blobs,
        {
          bytes,
          filename: file.name,
          isBundle,
          title: str(body["title"]),
          slug: str(body["slug"]),
          spa: body["spa"] === "true" || body["spa"] === "1",
          message: str(body["message"]),
          // Author is the authenticated identity (signed-in user or agent), never a
          // client-supplied field — a logged-in publish must be attributed to that
          // person. Anonymous callers can't reach this route at all, so a publish is
          // always attributed to a real principal (the token's optional `author`
          // label is the one headless exception).
          author: actor?.name ?? str(body["author"]),
          authorId: user?.id ?? null,
          name: str(body["name"]),
          orgId: org,
          visibility,
          passwordHash,
        },
        shortId,
      )
      // The publisher becomes the artifact's owner-member on creation. This is what
      // makes `private` work — workspace role grants nothing there, so without this
      // row the creator would lock themselves out — and it makes ownership explicit
      // for every artifact instead of implied by workspace role. Agents get the row
      // under their principal id (actorFor resolves members by that same id).
      if (!shortId && actor)
        await meta.setArtifactMember({
          id: newId("am"),
          artifact_id: artifact.id,
          user_id: actor.id,
          role: "owner",
        })
      bus.publish(artifact.id, {
        type: "version.published",
        n: version.n,
        message: version.message,
      })
      await notify(artifact, "version.published", {
        version: version.n,
        message: version.message,
        author: version.author,
      })
      // Fan out to the publisher's followers: "someone you follow published X". Gated to:
      // a real signed-in USER (agents/tokens have no human followers), a publicly-visible
      // artifact (a follow never surfaces a private title), and a NEW artifact only —
      // `shortId` means a republish/new version, which would otherwise spam followers on
      // every edit. Done in the background so a popular author's fan-out never adds to
      // publish latency (it's off the response path, like the comment-mention fan-out).
      if (!shortId && user?.id && artifact.visibility === "public") {
        const author = user
        background(
          (async () => {
            for (const follower of await meta.listFollowers(author.id, 200)) {
              if (follower.id === author.id) continue
              await meta.createNotification({
                id: newId("ntf"),
                user_id: follower.id,
                actor: author.name ?? author.username ?? "Someone",
                kind: "publish",
                artifact_id: artifact.id,
                artifact_short_id: artifact.short_id,
                artifact_title: artifact.title,
                thread_id: "",
                comment_id: "",
                preview: artifact.title ?? "published something new",
              })
            }
          })(),
        )
      }
      // Republish can resolve comment threads in the same call.
      const resolves = body["resolves"]
      if (shortId && typeof resolves === "string" && resolves) {
        for (const cid of resolves
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)) {
          const cm = await meta.getComment(cid)
          if (cm && cm.artifact_id === artifact.id) {
            await meta.setThreadState(artifact.id, cm.thread_id, "resolved")
            bus.publish(artifact.id, { type: "comment.resolved", thread_id: cm.thread_id })
          }
        }
      }
      // Re-anchor existing threads against the new version: feedback whose quoted
      // text changed flips to `outdated` (and back to `open` if it reappears).
      for (const t of await sweepAnchors(meta, blobs, artifact.id, version))
        bus.publish(artifact.id, {
          type: t.state === "outdated" ? "comment.outdated" : "comment.resolved",
          thread_id: t.thread_id,
          state: t.state,
        })
      const versions = await meta.listVersions(artifact.id)
      return c.json({ ...toJson(deps.baseUrl, artifact, versions), published: version.n }, 201)
    } catch (err) {
      if (err instanceof PublishError) return fail(c, err.statusCode as 400, err.message)
      throw err
    }
  }

  app.post("/v1/artifacts", (c) => handlePublish(c))
  app.post("/v1/artifacts/:shortId/versions", (c) => handlePublish(c, c.req.param("shortId")))

  app.get("/v1/artifacts/:shortId", async (c) => {
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    // For a missing artifact, fall back to the most restrictive visibility so
    // an anonymous probe can't learn anything (a non-member gets no access).
    const actor = await actorFor(c, artifact ?? ({ id: "", visibility: "org" } as ArtifactRecord))
    if (!artifact) return fail(c, 404, "not found")
    if (!can(actor, "read", artifact.visibility, artifact.general_role))
      // A password artifact isn't hidden, it's lockable: tell the client to prompt
      // for the password (401) rather than claim it doesn't exist (404).
      return artifact.visibility === "password"
        ? fail(c, 401, "password required")
        : fail(c, 404, "not found")
    // Taken down: serve a minimal tombstone, not the full record. A takedown is a
    // moderation action and the title is often the very thing being removed
    // (harassment/doxxing), so drop title, author, the slug in the URL, and the
    // version history — keep only enough for the SPA to render its "removed" state.
    // (Content already 410s at /raw; the /a unfurl injects no meta for removed.)
    if (artifact.removed_at)
      return c.json({
        short_id: artifact.short_id,
        url: `${deps.baseUrl.replace(/\/$/, "")}/artifacts/${artifact.short_id}`,
        title: null,
        kind: artifact.kind,
        visibility: artifact.visibility,
        spa: !!artifact.spa,
        current_version: artifact.current_version,
        created_at: artifact.created_at,
        versions: [],
        sessions: [],
        my_role: effectiveRole(actor, artifact.visibility),
        tags: [],
        favorite: false,
        collections: [],
        open_proposals: 0,
        proposals_total: 0,
        removed: true,
        managed: false,
      })
    const versions = await meta.listVersions(artifact.id)
    const me = actor.kind === "user" ? actor.userId : null
    const tags = (await meta.tagsForArtifacts([artifact.id]))[artifact.id] ?? []
    const favorite = me ? (await meta.listUserFavoriteIds(me)).includes(artifact.id) : false
    const collections = await meta.collectionIdsForArtifact(artifact.id)
    const proposals = await meta.listProposals(artifact.id)
    // A markdown bundle (a skill — entry SKILL.md — or a docs folder) gets a `bundle`
    // block: the entry + file tree (so the client can render the doc and navigate
    // siblings) plus skill identity when it is one. One manifest read, on the detail
    // page only — the list view stays blob-free (no N+1). HTML "site" bundles navigate
    // via their own links, so they get no block.
    let bundle: BundleDoc | undefined
    const cur =
      artifact.kind === "bundle"
        ? versions.find((v) => v.n === artifact.current_version)
        : undefined
    if (cur) {
      const manifestBytes = await blobs.get(cur.blob_key)
      if (manifestBytes) {
        const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as BundleManifest
        if (isMarkdownBundle(manifest)) bundle = bundleDoc(manifest, await sourceText(cur))
      }
    }
    // Resolve the GitHub author(s) to Derive profiles: collect every distinct gh_id on the
    // artifact + its versions, map them in ONE query, and attach a `handle` (the Derive
    // username) when the committer signed in with GitHub. Additive — the raw author_*
    // fields stay on the response regardless.
    const ghIds = new Set<string>()
    if (artifact.author_gh_id) ghIds.add(artifact.author_gh_id)
    for (const v of versions) if (v.author_gh_id) ghIds.add(v.author_gh_id)
    const handleByGhId = await resolveHandles(meta, [...ghIds])
    const base = toJson(deps.baseUrl, artifact, versions)
    // `versions` stays at revision granularity (machines/agents); `sessions` is
    // the time-grouped view the UI shows by default. `my_role` tells the client
    // which actions to surface; `open_proposals` badges the review queue while
    // `proposals_total` (everything but withdrawn) gates the Proposals entry so a
    // proposer can return to read feedback after their candidate leaves the queue.
    return c.json({
      ...base,
      // Resolved author profile for the current author (null when there's none, or the
      // committer never signed in with GitHub — then `handle` is null but name/login/avatar
      // still describe the GitHub identity). The frontend prefers this over the raw fields.
      author: authorProfile(artifact, handleByGhId),
      versions: base.versions.map((v) => ({
        ...v,
        handle: v.author_gh_id ? (handleByGhId[v.author_gh_id] ?? null) : null,
      })),
      sessions: groupSessions(versions, versionWindowMs),
      my_role: effectiveRole(actor, artifact.visibility, artifact.general_role),
      tags,
      favorite,
      collections,
      open_proposals: proposals.filter((p) => p.state === "open").length,
      proposals_total: proposals.filter((p) => p.state !== "withdrawn").length,
      // Present for a markdown bundle (skill or docs folder): { isSkill, name,
      // description, entry, files } — the client renders the file tree + skill chrome.
      ...(bundle ? { bundle } : {}),
      // A taken-down artifact keeps its record but serves no content (410); the
      // UI shows a tombstone instead of the iframe.
      removed: !!artifact.removed_at,
      // Mirrored from a GitHub sync source → read-only in Derive (the client hides
      // Edit/Propose; the publish/propose routes also refuse it server-side).
      managed: (await meta.managedArtifactIds(artifact.org_id)).includes(artifact.id),
    })
  })

  // Change general access (visibility + the general-access role) after publish — the
  // Share dialog's "general access" control. Editors+ (share), per the GDocs model.
  // `generalRole` is the floor the link grants a reacher (viewer = view-only, commenter =
  // authenticated reachers may comment; anonymous stays view-only regardless). Enabling
  // `password` needs a password (or keeps the existing one); any other visibility clears
  // the stored hash.
  app.patch("/v1/artifacts/:shortId/visibility", async (c) => {
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact) return fail(c, 404, "not found")
    if (!(await authorize(c, "share", artifact))) return fail(c, 403, "forbidden")
    const b = await readJson(
      c,
      z.object({
        visibility: z.string(),
        password: z.string().optional(),
        generalRole: z.enum(["viewer", "commenter"]).optional(),
      }),
    )
    if (b instanceof Response) return b
    const visibility = visibilityOf(b.visibility)
    if (!visibility) return fail(c, 400, "invalid visibility")
    const generalRole = b.generalRole ?? "viewer"
    let passwordHash: string | null = null
    if (visibility === "password") {
      if (b.password) passwordHash = hashPassword(b.password)
      else if (artifact.visibility === "password" && artifact.password_hash)
        passwordHash = artifact.password_hash
      else return fail(c, 400, "a password is required for password visibility")
    }
    await meta.setVisibility(artifact.id, visibility, passwordHash, generalRole)
    return c.json({ visibility, general_role: generalRole })
  })

  // Lock / unlock an artifact. Any editor (publish rights) can flip it. While
  // locked, direct publishes are rejected (handlePublish) so changes must go through
  // the proposal → approval flow; the web UI routes editors to "propose".
  app.patch("/v1/artifacts/:shortId/locked", async (c) => {
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact) return fail(c, 404, "not found")
    if (!(await authorize(c, "publish", artifact))) return fail(c, 403, "forbidden")
    const b = await readJson(c, z.object({ locked: z.boolean() }))
    if (b instanceof Response) return b
    await meta.setLocked(artifact.id, b.locked ? 1 : 0)
    return c.json({ locked: b.locked })
  })

  // Permanently delete an artifact and all its dependents (versions, comments,
  // proposals, memberships, etc.). Owner-only: gated by the `manage` action.
  app.delete("/v1/artifacts/:shortId", async (c) => {
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact) return fail(c, 404, "not found")
    if (!(await authorize(c, "manage", artifact))) return fail(c, 403, "forbidden")
    await meta.deleteArtifact(artifact.id, artifact.org_id)
    return new Response(null, { status: 204 })
  })

  // Unlock a `password` artifact: verify the password and drop a cookie whose
  // value is derived from the server-only hash (so it can't be forged and dies if
  // the password changes). Brute force is bounded by a dedicated tight limiter
  // (10 attempts/min per caller), well below the lenient global /v1 write cap.
  // authz-exempt: the password itself is the gate; any visitor may attempt unlock.
  app.post("/v1/artifacts/:shortId/unlock", async (c) => {
    const over = await limited(c, unlockLimiter)
    if (over) return over
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (artifact?.visibility !== "password" || !artifact.password_hash)
      return fail(c, 404, "not found")
    const b = await readJson(c, z.object({ password: z.string().min(1) }))
    if (b instanceof Response) return b
    if (!verifyPassword(b.password, artifact.password_hash)) return fail(c, 401, "wrong password")
    setCookie(
      c,
      unlockCookie(artifact.short_id),
      unlockToken(artifact.id, artifact.password_hash),
      {
        path: "/",
        maxAge: 60 * 60 * 24 * 30,
        httpOnly: true,
        sameSite: deps.crossSite ? "None" : "Lax",
        secure: deps.crossSite || new URL(deps.baseUrl).protocol === "https:",
      },
    )
    return c.json({ ok: true })
  })

  // Restore a past version: re-point a new revision at its stored blob (no
  // re-upload, works for files and bundles). History is never rewritten.
  app.post("/v1/artifacts/:shortId/restore", async (c) => {
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact) return fail(c, 404, "not found")
    if (!(await authorize(c, "publish", artifact))) return fail(c, 403, "forbidden")
    const body = await readJson(c, z.object({ version: z.number().int("version required") }))
    if (body instanceof Response) return body
    const src = await meta.getVersion(artifact.id, body.version)
    if (!src) return fail(c, 404, `no version ${body.version}`)
    const me = await currentUser(c)
    const version = await meta.addVersion(artifact.id, {
      id: newId("v"),
      blob_key: src.blob_key,
      content_type: src.content_type,
      // Same blob as the restored version — carry its size so the storage meter
      // stays consistent (and dedup'd, since it reuses the same blob_key).
      size_bytes: src.size_bytes,
      author: me ? (me.name ?? me.username ?? me.email) : "anonymous",
      author_id: me?.id ?? null,
      message: `Restored v${src.n}`,
      name: null,
    })
    await notify(artifact, "version.published", {
      version: version.n,
      message: version.message,
      author: version.author,
    })
    bus.publish(artifact.id, { type: "version.published", n: version.n, message: version.message })
    // Restoring an old blob is a content change too — re-anchor threads against it.
    for (const t of await sweepAnchors(meta, blobs, artifact.id, version))
      bus.publish(artifact.id, {
        type: t.state === "outdated" ? "comment.outdated" : "comment.resolved",
        thread_id: t.thread_id,
        state: t.state,
      })
    const fresh = (await meta.getByShortId(artifact.short_id)) as ArtifactRecord
    const versions = await meta.listVersions(artifact.id)
    return c.json(
      {
        ...toJson(deps.baseUrl, fresh, versions),
        sessions: groupSessions(versions, versionWindowMs),
        published: version.n,
      },
      201,
    )
  })

  // Source read-back for machines: returns an artifact's text content for any
  // version, as plain text (?v=N selects a version; defaults to current).
  app.get("/v1/artifacts/:shortId/content", async (c) => {
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact || artifact.current_version === 0 || !(await authorize(c, "read", artifact)))
      return fail(c, 404, "not found")
    if (artifact.removed_at) return fail(c, 410, TOMBSTONE)
    const v = c.req.query("v") ? Number(c.req.query("v")) : artifact.current_version
    if (!Number.isInteger(v)) return fail(c, 400, "bad version")
    const version = await meta.getVersion(artifact.id, v)
    if (!version) return fail(c, 404, `no version ${v}`)
    const src = await sourceText(version)
    if (src === null) return fail(c, 500, "blob missing")
    c.header("Content-Type", "text/plain; charset=utf-8")
    c.header("X-Content-Type-Options", "nosniff")
    c.header("Access-Control-Allow-Origin", "*")
    c.header("X-Derive-Version", String(v))
    c.header("X-Derive-Kind", artifact.kind)
    return c.body(src)
  })

  // Live editor preview: render a markdown draft to the exact published HTML.
  // Stateless (renders the caller's text, stores nothing) and signed-in only, so
  // it can't be used as an anonymous render farm. HTML drafts preview in the
  // browser, so this is markdown-only.
  app.post("/v1/preview", async (c) => {
    if (!(await actingUser(c))) return fail(c, 401, "unauthenticated")
    const body = await readJson(
      c,
      z.object({ source: z.string().max(500_000), title: z.string().max(300).nullish() }),
    )
    if (body instanceof Response) return body
    return c.json({ html: await renderMarkdown(body.source, body.title ?? null) })
  })

  // Line diff between two versions. Defaults to (current-1 → current).
  // ?format=json returns the structured ops; otherwise unified-style text.
  app.get("/v1/artifacts/:shortId/diff", async (c) => {
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact || artifact.current_version === 0 || !(await authorize(c, "read", artifact)))
      return fail(c, 404, "not found")
    const cur = artifact.current_version
    const from = c.req.query("from") ? Number(c.req.query("from")) : Math.max(1, cur - 1)
    const to = c.req.query("to") ? Number(c.req.query("to")) : cur
    if (!Number.isInteger(from) || !Number.isInteger(to)) return fail(c, 400, "bad version")
    const [vf, vt] = [
      await meta.getVersion(artifact.id, from),
      await meta.getVersion(artifact.id, to),
    ]
    if (!vf || !vt) return fail(c, 404, "version not found")
    const [a, b] = [await sourceText(vf), await sourceText(vt)]
    if (a === null || b === null) return fail(c, 500, "blob missing")
    const ops = diffLines(a, b)

    c.header("Access-Control-Allow-Origin", "*")
    c.header("X-Derive-From", String(from))
    c.header("X-Derive-To", String(to))
    if (c.req.query("format") === "json") return c.json({ from, to, ops })
    c.header("Content-Type", "text/plain; charset=utf-8")
    return c.body(formatDiff(ops))
  })

  return app
}
