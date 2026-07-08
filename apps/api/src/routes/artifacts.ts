import {
  type ArtifactRecord,
  artifactUrl,
  type BundleDoc,
  type BundleManifest,
  bundleDoc,
  can,
  capRole,
  diffLines,
  EditError,
  effectiveRole,
  formatDiff,
  groupSessions,
  isHtmlLike,
  isMarkdownBundle,
  newId,
  outlineOf,
  PublishError,
  pageText,
  publish,
  renderMarkdown,
  sectionOf,
  toJson,
  toMarkdown,
} from "@derive/core"
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { Context } from "hono"
import { setCookie } from "hono/cookie"
import type { BlankEnv } from "hono/types"
import type { AppContext } from "../context"
import { publishSweepEvents } from "../lib/anchor-sweep"
import { authorProfile, resolveHandles } from "../lib/author"
import { cleanPath, manifestOf } from "../lib/bundle"
import { hashPassword, signState, unlockCookie, unlockToken, verifyPassword } from "../lib/crypto"
import {
  EditConflictError,
  type MaterializedEdits,
  materializeEdits,
  parseBaseVersion,
} from "../lib/edits"
import { buildReviewEmail } from "../lib/email"
import {
  bail,
  DEFAULT_WORKSPACE_NAME,
  fail,
  legacyAccessOf,
  linkRoleOf,
  listedOf,
  MAX_UPLOAD_BYTES,
  readJson,
  str,
  TOMBSTONE,
  toBody,
  workspaceAccessOf,
} from "../lib/http"
import { Artifact } from "../schemas"
import { enqueueChannelDelivery } from "../webhooks"

// Bundle asset types the /content route serves with their real Content-Type. Not
// image/svg+xml: an SVG is a scriptable document when a browser navigates to it
// directly, and this route (unlike /raw/, which sandboxes every asset behind a CSP)
// has no such isolation — anything off this list serves as application/octet-stream.
const SAFE_BINARY_CONTENT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/x-icon",
  "image/vnd.microsoft.icon",
  "font/woff",
  "font/woff2",
  "font/ttf",
  "font/otf",
  "text/css",
  "application/javascript",
  "text/javascript",
  "application/json",
])

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
    notifyRender,
    background,
    isMember,
    isToken,
    currentUser,
    actingUser,
    privateOwnerId,
    activeWorkspace,
    actorFor,
    agentFor,
    authorize,
    workspaceCan,
    collectionRole,
    limited,
    overStorage,
    publishLimiter,
    unlockLimiter,
    sourceText,
  } = ctx
  const app = new OpenAPIHono<BlankEnv>()

  // Newest-first, keyset-paginated (?cursor=<created_at>&limit=N), with optional
  // server-side ?query= (title search), ?tag=, and ?favorite=true. Returns
  // { artifacts, next_cursor }. tag/favorite resolve to an id set first.
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/artifacts",
      tags: ["Artifacts"],
      summary:
        "List artifacts (keyset-paginated; ?query=/tag=/collection=/scope=/author=/favorite=).",
      responses: {
        200: {
          description: "A page of artifacts + next cursor (+ the collection when scoped to one).",
          content: {
            "application/json": {
              schema: z.object({
                artifacts: z.array(Artifact),
                next_cursor: z.string().nullable(),
                collection: z.object({ id: z.string(), title: z.string() }).optional(),
              }),
            },
          },
        },
      },
    }),
    async (c) => {
      const me = await currentUser(c)
      // Registered/OAuth agents list too — their library is how MCP list_artifacts
      // finds work. Anonymous stays 401: nothing in the product lists tokenless.
      const agent = me ? null : await agentFor(c)
      if (!me && !agent && !isToken(c)) return bail(fail(c, 401, "unauthenticated"))
      // Whose member rows count. Listing must mirror can(read): an agent derives
      // its standing from its registrant's rows (capped at its registered role —
      // see actorFor), so a linked agent's key is the REGISTRANT; an agent with
      // no registrant on record falls back to its own legacy rows.
      const memberKey = me?.id ?? agent?.created_by ?? agent?.id ?? null
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
      // scope=mine → everything the caller owns in this workspace (their owner
      // member row — written at creation for the human behind the publish, agents
      // included), any visibility — the library's "Created by me" filter.
      const mineScope = c.req.query("scope") === "mine"
      if (mineScope) {
        if (!me) return c.json({ artifacts: [], next_cursor: null })
        narrow(await meta.artifactIdsOwnedBy(await activeWorkspace(c), me.id))
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
          (await isMember(c, col.org_id)) || (await collectionRole(c, col)) !== null
      }
      // Author filter narrows to artifacts last changed by a GitHub login, scoped to the
      // listing's workspace (after collection scope has settled listOrg). Mirrors ?tag=.
      if (author) narrow(await meta.artifactIdsByAuthor(listOrg, author))
      if (ids && ids.length === 0) return c.json({ artifacts: [], next_cursor: null })

      // The caller's baseline standing in the listing's workspace — reused for the
      // public-only clamp below and the per-row `my_role` (which needs the ROLE, so
      // the boolean isMember helper doesn't fit). A user's standing is their
      // membership row; an agent's is its registered role, valid only in its home
      // workspace (the same scoping actorFor applies).
      const isOperator = isToken(c)
      const baselineRole = me
        ? ((await meta.getMembership(listOrg, me.id))?.role ?? null)
        : agent && agent.org_id === listOrg
          ? agent.role
          : null
      // A listing only shows non-public artifacts to a MEMBER of that workspace (or the
      // operator token). Anyone else — a non-member user, a foreign-workspace agent —
      // sees public artifacts only, so org/link titles never leak via the list or ?query=.
      // For a collection, collection access (member/creator/share) also unlocks it.
      const publicOnly = collectionId ? !collectionAccess : !(isOperator || baselineRole !== null)
      // "Created by me" is a members-only view of the caller's OWN authored work —
      // a caller with no standing here (or no member rows to match) has none by definition.
      if (mineScope && (publicOnly || !memberKey))
        return c.json({ artifacts: [], next_cursor: null })
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
        // Private artifacts appear only for their explicit members (the publisher's
        // owner row included, so agents and owners always find their own drafts);
        // the operator token sees everything (viewerId omitted).
        viewerId: isOperator ? undefined : (memberKey ?? undefined),
      })
      const hasMore = rows.length > limit
      const page = hasMore ? rows.slice(0, limit) : rows
      const last = page[page.length - 1]
      const next_cursor = hasMore && last ? `${last.created_at}|${last.id}` : null

      const pageIds = page.map((a) => a.id)
      const counts = analyticsOn ? await meta.viewCounts(pageIds) : {}
      const tags = await meta.tagsForArtifacts(pageIds)
      const previews = await meta.previewReady(pageIds)
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
      // For a linked agent these are the registrant's rows, so the cap applies.
      const shareRoles = memberKey ? await meta.artifactRolesFor(memberKey, pageIds) : {}
      return c.json({
        artifacts: page.map((a) => ({
          ...toJson(deps.baseUrl, a, []),
          views: counts[a.id] ?? 0,
          tags: tags[a.id] ?? [],
          favorite: favorites.has(a.id),
          has_preview: previews[a.id] === true,
          // Which actions the client may surface on the row (the card's quick-actions
          // menu gates delete/tags on it). Workspace seat + per-artifact shares + the
          // world-link floor; collection-share roles aren't folded in at list
          // granularity, so the detail response's my_role stays authoritative.
          my_role: isOperator
            ? "owner"
            : effectiveRole(
                memberKey
                  ? {
                      kind: "user",
                      userId: memberKey,
                      artifactRole:
                        agent?.created_by != null
                          ? capRole(shareRoles[a.id] ?? null, agent.role)
                          : (shareRoles[a.id] ?? null),
                      orgRole: a.org_id === listOrg ? baselineRole : null,
                    }
                  : { kind: "anon" },
                a.workspace_access,
                a.link_role,
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
    },
  )

  // Browse summary for the sidebar: total artifacts, this user's favorite count,
  // and tag → count (so counts stay accurate independent of the current page).
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/tags",
      tags: ["Artifacts"],
      summary: "Browse summary for the sidebar (totals + tag counts).",
      responses: {
        200: {
          description:
            "Total artifacts, the caller's favorite/owned counts, tag→count, and workspace name.",
          content: {
            "application/json": {
              schema: z.object({
                total: z.number(),
                favorites: z.number(),
                mine: z.number(),
                mine_private: z.number(),
                tags: z.array(z.object({ tag: z.string(), count: z.number() })),
                workspace: z.string().nullable(),
              }),
            },
          },
        },
      },
    }),
    async (c) => {
      const me = await currentUser(c)
      if (!me && !isToken(c)) return bail(fail(c, 401, "unauthenticated"))
      const org = await activeWorkspace(c)
      // The sidebar summary (workspace name, total artifact count, tag breakdown) is a
      // member view. A non-member — including an anonymous caller in open mode — gets an
      // empty summary with no workspace name, so it can't be used to enumerate a private
      // workspace's name + size.
      if (!(await isMember(c, org)))
        return c.json({
          total: 0,
          favorites: 0,
          mine: 0,
          mine_private: 0,
          tags: [],
          workspace: null,
        })
      const [total, tags, favIds, ws, mine, minePrivate] = await Promise.all([
        meta.countArtifacts(org),
        meta.tagCounts(org),
        // Scope the favorites count to THIS workspace's live artifacts — the favorites
        // view is workspace-scoped, so a favorite of an artifact in another workspace
        // must not inflate the count (otherwise "Favorites · 1" with an empty list).
        me ? meta.listUserFavoriteIds(me.id, org) : Promise.resolve([]),
        meta.getWorkspace(org),
        // The caller's owned artifacts — the "Created by me" filter's badge.
        me ? meta.countOwnedBy(org, me.id) : Promise.resolve(0),
        // …and how many of those aren't surfaced anywhere yet: the "waiting on you
        // to share it" signal (a fresh publish is listed=none until promoted).
        me ? meta.countOwnedBy(org, me.id, "none") : Promise.resolve(0),
      ])
      tags.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
      return c.json({
        total,
        favorites: favIds.length,
        mine,
        mine_private: minePrivate,
        tags,
        workspace: ws?.name ?? DEFAULT_WORKSPACE_NAME,
      })
    },
  )

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

    // `edits` — a token-cheap revision (stdio/API parity with the MCP publish
    // tool's `edits`): exact-match search/replace against the current stored
    // source instead of a re-uploaded `file`. Materialize the full content, then
    // fall through to the same publish path everything else uses.
    const editsField = body["edits"]
    let bytes: Uint8Array
    let filename: string
    let isBundle: boolean
    if (typeof editsField === "string") {
      if (!shortId || !existing)
        return fail(c, 400, "edits revises an EXISTING artifact — POST to its /versions endpoint")
      let edits: { old_str: string; new_str: string }[]
      try {
        edits = JSON.parse(editsField)
      } catch {
        return fail(c, 400, "edits must be a JSON array of {old_str,new_str}")
      }
      let materialized: MaterializedEdits
      try {
        const baseVersion = parseBaseVersion(str(body["base_version"]))
        materialized = await materializeEdits(
          { getVersion: meta.getVersion.bind(meta), sourceText },
          existing,
          edits,
          baseVersion,
        )
      } catch (e) {
        if (e instanceof EditConflictError) return fail(c, 409, e.message)
        return fail(
          c,
          e instanceof EditError ? 400 : 500,
          e instanceof Error ? e.message : "edit failed",
        )
      }
      bytes = new TextEncoder().encode(materialized.content)
      if (bytes.length > MAX_UPLOAD_BYTES) return fail(c, 413, "upload too large")
      if (await overStorage(org, bytes.length)) return fail(c, 413, "storage quota exceeded")
      filename = materialized.filename
      isBundle = false
    } else {
      const file = body["file"]
      if (!(file instanceof File)) return fail(c, 400, "multipart field 'file' required")
      bytes = new Uint8Array(await file.arrayBuffer())
      // The content-length header is advisory (a client can omit/understate it),
      // so re-check the actual buffered size — the hard cap before anything stores.
      if (bytes.length > MAX_UPLOAD_BYTES) return fail(c, 413, "upload too large")
      if (await overStorage(org, bytes.length)) return fail(c, 413, "storage quota exceeded")
      filename = file.name
      isBundle =
        /\.zip$/i.test(file.name) ||
        body["kind"] === "bundle" ||
        (bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 3 || bytes[2] === 5))
    }

    // Access is three single-purpose fields (see access-model.md). Each is validated
    // here; an explicitly-provided value that isn't a known literal is rejected, not
    // coerced — a typo must never publish more openly than intended. A legacy
    // `visibility` (link/unlisted/password/workspace map in legacyAccessOf) seeds all
    // three for a pinned client; explicit v2 fields win over it during resolution.
    const rawVisibility = str(body["visibility"])
    const rawGeneralRole = str(body["general_role"])
    const legacy = rawVisibility
      ? legacyAccessOf(rawVisibility, linkRoleOf(rawGeneralRole))
      : undefined
    if (rawVisibility && !legacy)
      return fail(c, 400, "visibility must be one of: public, org, private")

    const rawWorkspaceAccess = str(body["workspace_access"])
    const workspaceAccess = workspaceAccessOf(rawWorkspaceAccess)
    if (rawWorkspaceAccess && !workspaceAccess)
      return fail(c, 400, "workspace_access must be one of: none, member")

    // `general_role` is a legacy alias for the world link role (pre-v2 clients only
    // ever sent viewer/commenter — see linkRoleOf).
    const rawLinkRole = str(body["link_role"]) ?? rawGeneralRole
    const linkRole = linkRoleOf(rawLinkRole)
    if (rawLinkRole && !linkRole)
      return fail(c, 400, "link_role must be one of: none, viewer, commenter, editor")

    const rawListed = str(body["listed"])
    const listed = listedOf(rawListed)
    if (rawListed && !listed) return fail(c, 400, "listed must be one of: none, workspace, public")

    // A password locks the world link. Legacy `visibility=password` must carry one on
    // create (or it would publish silently open) — the same 400 old clients always got.
    const password = str(body["password"])
    if (!shortId && rawVisibility === "password" && !password)
      return fail(c, 400, "a password is required for password visibility")

    try {
      // The authenticated principal behind this publish (signed-in user or agent) — its
      // `name` is the display author. The Derive-USER behind it is what we attribute
      // work to: for an agent, the user it acts on behalf of (created_by / the OAuth
      // grantor). `author_id` keys a person's profile + their followers' feed, so it
      // must be a real user id, never an agent principal.
      const actor = await actingUser(c)
      const onBehalf = await privateOwnerId(c)
      // The agent behind an agent-credentialed publish (registered token / OAuth
      // bearer) — its name is the actor on the human's notification fan-out below.
      const agentPrincipal = await agentFor(c)
      // Access is set-on-create: a republish never re-stamps it (publish() only adds a
      // version). On a NEW artifact each field resolves independently — explicit request
      // field > legacy `visibility` mapping > the workspace default (factory default is
      // the "team draft": workspace_access=member, link_role=none, listed=none). One
      // org-settings read covers all three defaults.
      const settings = !shortId ? await meta.getOrgSettings(org) : null
      const resolvedWorkspaceAccess = !shortId
        ? (workspaceAccess ?? legacy?.workspace_access ?? settings?.defaultWorkspaceAccess)
        : undefined
      const resolvedLinkRole = !shortId
        ? (linkRole ?? legacy?.link_role ?? settings?.defaultLinkRole)
        : undefined
      const resolvedListed = !shortId
        ? (listed ?? legacy?.listed ?? settings?.defaultListed)
        : undefined
      // The only cross-field invariants are the two listing preconditions: a doc can't
      // be listed somewhere it grants no access to. Explicit contradictions are rejected,
      // not coerced.
      if (!shortId && resolvedListed === "workspace" && resolvedWorkspaceAccess !== "member")
        return fail(c, 400, "a workspace-listed artifact must grant workspace access")
      if (!shortId && resolvedListed === "public" && resolvedLinkRole === "none")
        return fail(c, 400, "a publicly-listed artifact must grant at least a viewer link")
      // A password locks the world link; a lock with no link is meaningless, so it only
      // takes when link_role != none.
      const passwordHash =
        resolvedLinkRole && resolvedLinkRole !== "none" && password
          ? hashPassword(password)
          : undefined
      const { artifact, version } = await publish(
        meta,
        blobs,
        {
          bytes,
          filename,
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
          authorId: onBehalf,
          name: str(body["name"]),
          orgId: org,
          workspaceAccess: resolvedWorkspaceAccess,
          passwordHash,
          linkRole: resolvedLinkRole,
          listed: resolvedListed,
        },
        shortId,
      )
      // Ownership on creation: ONE row, the human behind the publish (an agent
      // publishes on behalf of whoever registered it) — this is what makes
      // `private` work, since workspace role grants nothing there. The agent
      // needs no row: it borrows its registrant's standing, capped at its
      // registered role (see actorFor). An agent with no registrant on record
      // owns as itself. Members stay a human sharing contract — no robots in
      // the roster.
      const ownerId = onBehalf ?? actor?.id ?? null
      if (!shortId && ownerId)
        await meta.setArtifactMember({
          id: newId("am"),
          artifact_id: artifact.id,
          user_id: ownerId,
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
      notifyRender(artifact, version.n)
      // Fan out to the publisher's followers: "someone you follow published X". Gated
      // to a known HUMAN behind the publish (their followers are who care — an agent
      // publish fans out to the followers of the person it acts for), a publicly-
      // visible artifact (a follow never surfaces a private title), and a NEW artifact
      // only — `shortId` means a republish/new version, which would otherwise spam
      // followers on every edit. Done in the background so a popular author's fan-out
      // never adds to publish latency (like the comment-mention fan-out).
      if (!shortId && onBehalf && artifact.listed === "public") {
        background(
          (async () => {
            const [author] = await meta.getUsers([onBehalf])
            if (!author) return
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
      await publishSweepEvents(meta, blobs, bus, artifact.id, version)
      // Open a review round if the publisher asked for one (the /derive loop). The
      // reviewer is the human behind the publish (onBehalf covers both a session
      // user and an agent's registrant); falls back to the workspace's first owner
      // so a headless publish still has someone to ask. No human to ask → skip.
      let roundCreated = false
      if (body["request_review"] === "true" || body["request_review"] === "1") {
        const reviewer =
          onBehalf ??
          (await meta.listMemberships(org)).find((m) => m.role === "owner")?.user_id ??
          null
        if (reviewer) {
          const round = await meta.createReviewRound({
            id: newId("rr"),
            artifact_id: artifact.id,
            version: version.n,
            requested_by: actor?.id ?? "agent",
            requested_for: reviewer,
            note: str(body["review_note"]) ?? null,
          })
          roundCreated = true
          bus.publish(artifact.id, { type: "review.requested", round_id: round.id })
          await notify(artifact, "review.requested", {
            version: version.n,
            requested_by: actor?.name ?? "An agent",
          })
          // The review request is the one event that earns an email: the loop is
          // blocked on the reviewer, who may have no tab open. Never for your own
          // request on yourself (a human publishing with request_review).
          if (reviewer !== actor?.id && (await meta.getOrgSettings(org)).emailNotifications) {
            const [r] = await meta.getUsers([reviewer])
            if (r?.email)
              await enqueueChannelDelivery(meta, "email", "review.requested", {
                to: r.email,
                toName: r.name ?? undefined,
                ...buildReviewEmail(deps.baseUrl, artifact, {
                  requestedBy: actor?.name ?? "An agent",
                  version: version.n,
                  note: str(body["review_note"]) ?? null,
                }),
              })
          }
        }
      }
      // The MCP loop over HTTP: an AGENT-credentialed publish (a registered
      // dk_agt_ token or an OAuth bearer — the CLI and stdio-shim paths) reaches
      // its human exactly like the /mcp path does: one bell row per push (a
      // review ask beats a plain publish), then artifact.pushed on their user
      // channel so an open tab auto-opens. A signed-in human's own save gets
      // none of this — they're already looking at it.
      let openedInTab: boolean | null = null
      if (agentPrincipal && onBehalf) {
        if (roundCreated || !shortId) {
          const row = {
            id: newId("n"),
            user_id: onBehalf,
            actor: agentPrincipal.name,
            kind: roundCreated ? ("review" as const) : ("publish" as const),
            artifact_id: artifact.id,
            artifact_short_id: artifact.short_id,
            artifact_title: artifact.title,
            thread_id: "",
            comment_id: "",
            preview: roundCreated
              ? `requested your review of v${version.n}`
              : (artifact.title ?? "published something new"),
          }
          await meta.createNotification(row)
          bus.publish(`u:${onBehalf}`, {
            type: "notification",
            notification: { ...row, read: 0, created_at: new Date().toISOString() },
          })
        }
        const pushed = {
          type: "artifact.pushed" as const,
          event_id: newId("ev"),
          short_id: artifact.short_id,
          artifact_id: artifact.id,
          title: artifact.title,
          version: version.n,
          kind: shortId ? "revised" : "created",
          url: artifactUrl(deps.baseUrl, artifact),
          agent: agentPrincipal.name,
          review_requested: roundCreated,
        }
        if (bus.publishWithReceipt) {
          openedInTab = await Promise.race([
            bus.publishWithReceipt(`u:${onBehalf}`, pushed).then((n) => n > 0),
            new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1500)),
          ])
        } else {
          bus.publish(`u:${onBehalf}`, pushed)
          openedInTab = false
        }
      }
      const versions = await meta.listVersions(artifact.id)
      return c.json(
        {
          ...toJson(deps.baseUrl, artifact, versions),
          published: version.n,
          ...(roundCreated ? { review_requested: true } : {}),
          ...(openedInTab !== null ? { opened_in_tab: openedInTab } : {}),
        },
        201,
      )
    } catch (err) {
      if (err instanceof PublishError) return fail(c, err.statusCode as 400, err.message)
      throw err
    }
  }

  app.post("/v1/artifacts", (c) => handlePublish(c))
  app.post("/v1/artifacts/:shortId/versions", (c) => handlePublish(c, c.req.param("shortId")))

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/artifacts/{shortId}",
      tags: ["Artifacts"],
      summary: "One artifact with its versions, sessions, roles, and counts.",
      request: { params: z.object({ shortId: z.string() }) },
      responses: {
        200: {
          description: "The artifact detail (or a minimal tombstone when taken down).",
          content: { "application/json": { schema: Artifact } },
        },
      },
    }),
    async (c) => {
      const artifact = await meta.getByShortId(c.req.param("shortId"))
      // For a missing artifact, fall back to a no-access placeholder so an anonymous
      // probe can't learn anything (only id/password_hash/org_id are read by actorFor,
      // and we 404 immediately after).
      const actor = await actorFor(c, artifact ?? ({ id: "" } as ArtifactRecord))
      if (!artifact) return bail(fail(c, 404, "not found"))
      if (!can(actor, "read", artifact.workspace_access, artifact.link_role))
        // A locked artifact isn't hidden, it's lockable: tell the client to prompt for
        // the password (401) rather than claim it doesn't exist (404). A lock only ever
        // sits on a world link, so a stored hash means the world-link path is gated.
        return bail(
          artifact.password_hash ? fail(c, 401, "password required") : fail(c, 404, "not found"),
        )
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
          workspace_access: artifact.workspace_access,
          link_role: artifact.link_role,
          listed: artifact.listed,
          spa: !!artifact.spa,
          current_version: artifact.current_version,
          created_at: artifact.created_at,
          versions: [],
          sessions: [],
          my_role: effectiveRole(actor, artifact.workspace_access, artifact.link_role),
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
        my_role: effectiveRole(actor, artifact.workspace_access, artifact.link_role),
        // The artifact's current workspace — the move dialog needs this to exclude
        // it from the destination picker.
        org_id: artifact.org_id,
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
        // The content iframe is sandboxed with no `allow-same-origin` (opaque origin —
        // it must not be able to touch derive.to cookies/storage), which means it also has
        // no origin of its own to send OUR session cookie back on, and Chrome refuses to
        // attach cookies to requests from an opaque origin at all (even same-site) — every
        // sub-resource (image, css, ...) in a non-public bundle 404s there. `read` access
        // was just proven above, so mint a short-lived capability the SPA embeds in the raw
        // URL's path (raw.ts's `t/:token` route + RAW_TOKEN_MAX_AGE_MS) — path, not query,
        // so relative asset references inherit it with zero HTML rewriting.
        raw_token: signState({ rid: artifact.id }, deps.encryptionKey ?? ""),
      })
    },
  )

  // Change access after publish — the Share dialog's controls. Three independent
  // fields (see access-model.md): workspace_access (do the workspace's members reach
  // it at their seat role), link_role (what merely holding the URL confers — anon
  // stays view-only), and listed (where it surfaces for discovery). Editors+ (share),
  // per the GDocs model. Omitting a field PRESERVES the current value (this is an
  // update, not a create). A legacy `visibility` (from a pinned client) seeds all
  // three; explicit v2 fields win. Password locks the world link.
  app.openapi(
    createRoute({
      method: "patch",
      path: "/v1/artifacts/{shortId}/access",
      tags: ["Artifacts"],
      summary: "Change an artifact's access (workspace access, world link, listing).",
      request: { params: z.object({ shortId: z.string() }) },
      responses: {
        200: {
          description: "The new access triple and lock state.",
          content: {
            "application/json": {
              schema: z.object({
                workspace_access: z.enum(["none", "member"]),
                link_role: z.enum(["none", "viewer", "commenter", "editor"]),
                listed: z.enum(["none", "workspace", "public"]),
                locked: z.boolean(),
              }),
            },
          },
        },
      },
    }),
    async (c) => {
      const artifact = await meta.getByShortId(c.req.param("shortId"))
      if (!artifact) return bail(fail(c, 404, "not found"))
      if (!(await authorize(c, "share", artifact))) return bail(fail(c, 403, "forbidden"))
      const b = await readJson(
        c,
        z.object({
          workspaceAccess: z.enum(["none", "member"]).optional(),
          linkRole: z.enum(["none", "viewer", "commenter", "editor"]).optional(),
          listed: z.enum(["none", "workspace", "public"]).optional(),
          password: z.string().optional(),
          // Legacy wire (pre-v2 clients): `visibility` maps onto the triple, `generalRole`
          // is the old spelling of the world link role.
          visibility: z.string().optional(),
          generalRole: z.enum(["viewer", "commenter"]).optional(),
        }),
      )
      if (b instanceof Response) return bail(b)
      const legacy =
        b.visibility !== undefined ? legacyAccessOf(b.visibility, b.generalRole) : undefined
      if (b.visibility !== undefined && !legacy) return bail(fail(c, 400, "invalid visibility"))
      const workspaceAccess =
        b.workspaceAccess ?? legacy?.workspace_access ?? artifact.workspace_access
      const linkRole = b.linkRole ?? b.generalRole ?? legacy?.link_role ?? artifact.link_role
      const listed = b.listed ?? legacy?.listed ?? artifact.listed
      // The only cross-field invariants: a doc can't be listed where it grants no access.
      if (listed === "workspace" && workspaceAccess !== "member")
        return bail(fail(c, 400, "a workspace-listed artifact must grant workspace access"))
      if (listed === "public" && linkRole === "none")
        return bail(fail(c, 400, "a publicly-listed artifact must grant at least a viewer link"))
      // The lock gates the world link — it only takes while a link exists. Supplying a
      // password (re)sets it, an empty string clears it, omitting keeps the current lock;
      // dropping the link (link_role=none) always clears it.
      let passwordHash: string | null = null
      if (linkRole !== "none") {
        if (b.password) passwordHash = hashPassword(b.password)
        else if (b.password === undefined) passwordHash = artifact.password_hash ?? null
      }
      // Legacy `visibility=password` means "link + lock": it must carry a password.
      if (b.visibility === "password" && !passwordHash)
        return bail(fail(c, 400, "a password is required for password visibility"))
      await meta.setAccess(artifact.id, workspaceAccess, listed, linkRole, passwordHash)
      return c.json({
        workspace_access: workspaceAccess,
        link_role: linkRole,
        listed,
        locked: !!passwordHash,
      })
    },
  )

  // Lock / unlock an artifact. Any editor (publish rights) can flip it. While
  // locked, direct publishes are rejected (handlePublish) so changes must go through
  // the proposal → approval flow; the web UI routes editors to "propose".
  app.openapi(
    createRoute({
      method: "patch",
      path: "/v1/artifacts/{shortId}/locked",
      tags: ["Artifacts"],
      summary: "Lock or unlock an artifact (locked ⇒ changes go through review).",
      request: { params: z.object({ shortId: z.string() }) },
      responses: {
        200: {
          description: "The new locked state.",
          content: { "application/json": { schema: z.object({ locked: z.boolean() }) } },
        },
      },
    }),
    async (c) => {
      const artifact = await meta.getByShortId(c.req.param("shortId"))
      if (!artifact) return bail(fail(c, 404, "not found"))
      if (!(await authorize(c, "publish", artifact))) return bail(fail(c, 403, "forbidden"))
      const b = await readJson(c, z.object({ locked: z.boolean() }))
      if (b instanceof Response) return bail(b)
      await meta.setLocked(artifact.id, b.locked ? 1 : 0)
      return c.json({ locked: b.locked })
    },
  )

  // Permanently delete an artifact and all its dependents (versions, comments,
  // proposals, memberships, etc.). Owner-only: gated by the `manage` action.
  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/artifacts/{shortId}",
      tags: ["Artifacts"],
      summary: "Permanently delete an artifact and all its dependents (owner only).",
      request: { params: z.object({ shortId: z.string() }) },
      responses: { 204: { description: "The artifact was deleted." } },
    }),
    async (c) => {
      const artifact = await meta.getByShortId(c.req.param("shortId"))
      if (!artifact) return bail(fail(c, 404, "not found"))
      if (!(await authorize(c, "manage", artifact))) return bail(fail(c, 403, "forbidden"))
      await meta.deleteArtifact(artifact.id, artifact.org_id)
      return c.body(null, 204)
    },
  )

  // Move to a different workspace you belong to. Owner-only (the `manage` gate —
  // same as delete). No role requirement on the destination: you can move into a
  // workspace where you're just a viewer/editor. A future org-level "block
  // cross-workspace moves" policy is a single guard here, not a new subsystem.
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/artifacts/{shortId}/move",
      tags: ["Artifacts"],
      summary: "Move an artifact to another workspace you belong to (owner only).",
      request: { params: z.object({ shortId: z.string() }) },
      responses: {
        200: {
          description: "The artifact's new workspace id.",
          content: { "application/json": { schema: z.object({ org_id: z.string() }) } },
        },
      },
    }),
    async (c) => {
      const artifact = await meta.getByShortId(c.req.param("shortId"))
      if (!artifact) return bail(fail(c, 404, "not found"))
      if (!(await authorize(c, "manage", artifact))) return bail(fail(c, 403, "forbidden"))
      const b = await readJson(c, z.object({ targetOrgId: z.string().min(1) }))
      if (b instanceof Response) return bail(b)
      if (b.targetOrgId === artifact.org_id) return bail(fail(c, 400, "already in that workspace"))
      const me = await currentUser(c)
      if (!me) return bail(fail(c, 401, "unauthenticated"))
      if (!(await meta.getMembership(b.targetOrgId, me.id)))
        return bail(fail(c, 403, "you're not a member of that workspace"))
      // A bound custom domain routes by artifact_id; moving orgs out from under it
      // would silently break live traffic, so refuse rather than cascade.
      if ((await meta.getArtifactDomains(artifact.id)).length > 0)
        return bail(fail(c, 409, "remove the custom domain before moving this artifact"))
      await meta.moveArtifactOrg(artifact.id, b.targetOrgId)
      return c.json({ org_id: b.targetOrgId })
    },
  )

  // Unlock a password-locked artifact: verify the password and drop a cookie whose
  // value is derived from the server-only hash (so it can't be forged and dies if
  // the password changes). Brute force is bounded by a dedicated tight limiter
  // (10 attempts/min per caller), well below the lenient global /v1 write cap.
  // authz-exempt: the password itself is the gate; any visitor may attempt unlock.
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/artifacts/{shortId}/unlock",
      tags: ["Artifacts"],
      summary: "Unlock a password-protected artifact (drops an unlock cookie).",
      request: { params: z.object({ shortId: z.string() }) },
      responses: {
        200: {
          description: "Unlocked.",
          content: { "application/json": { schema: z.object({ ok: z.boolean() }) } },
        },
      },
    }),
    async (c) => {
      const over = await limited(c, unlockLimiter)
      if (over) return bail(over)
      const artifact = await meta.getByShortId(c.req.param("shortId"))
      if (!artifact?.password_hash) return bail(fail(c, 404, "not found"))
      const b = await readJson(c, z.object({ password: z.string().min(1) }))
      if (b instanceof Response) return bail(b)
      if (!verifyPassword(b.password, artifact.password_hash))
        return bail(fail(c, 401, "wrong password"))
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
    },
  )

  // Restore a past version: re-point a new revision at its stored blob (no
  // re-upload, works for files and bundles). History is never rewritten.
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/artifacts/{shortId}/restore",
      tags: ["Artifacts"],
      summary: "Restore a past version as a new revision (history is never rewritten).",
      request: { params: z.object({ shortId: z.string() }) },
      responses: {
        201: {
          description: "The artifact after restore, plus the new version number.",
          content: { "application/json": { schema: Artifact.extend({ published: z.number() }) } },
        },
      },
    }),
    async (c) => {
      const artifact = await meta.getByShortId(c.req.param("shortId"))
      if (!artifact) return bail(fail(c, 404, "not found"))
      if (!(await authorize(c, "publish", artifact))) return bail(fail(c, 403, "forbidden"))
      const body = await readJson(c, z.object({ version: z.number().int("version required") }))
      if (body instanceof Response) return bail(body)
      const src = await meta.getVersion(artifact.id, body.version)
      if (!src) return bail(fail(c, 404, `no version ${body.version}`))
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
      notifyRender(artifact, version.n)
      bus.publish(artifact.id, {
        type: "version.published",
        n: version.n,
        message: version.message,
      })
      // Restoring an old blob is a content change too — re-anchor threads against it.
      await publishSweepEvents(meta, blobs, bus, artifact.id, version)
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
    },
  )

  // Source read-back for machines: returns an artifact's text content for any
  // version, as plain text (?v=N selects a version; defaults to current).
  //
  // ?format=markdown|text renders instead of returning raw source (default: raw,
  // for existing byte-exact consumers). ?outline=1 returns a JSON heading/page
  // outline instead of content. ?section=<slug|page|page#slug> returns just that
  // part. X-Derive-* response headers double as a capability probe for older
  // clients that predate these params (self-hosted stdio server parity).
  app.get("/v1/artifacts/:shortId/content", async (c) => {
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact || artifact.current_version === 0 || !(await authorize(c, "read", artifact)))
      return fail(c, 404, "not found")
    if (artifact.removed_at) return fail(c, 410, TOMBSTONE)
    const v = c.req.query("v") ? Number(c.req.query("v")) : artifact.current_version
    if (!Number.isInteger(v)) return fail(c, 400, "bad version")
    const version = await meta.getVersion(artifact.id, v)
    if (!version) return fail(c, 404, `no version ${v}`)

    const formatQ = c.req.query("format")
    const format = formatQ === "markdown" || formatQ === "text" ? formatQ : null
    // "*" forces full content — the escape hatch a caller uses after already
    // seeing (or skipping) the outline, same sentinel the MCP `read` tool takes.
    const sectionQ = c.req.query("section")
    const section = sectionQ && sectionQ !== "*" ? sectionQ : null
    const outline = c.req.query("outline") === "1"
    const present = (source: string, contentType: string): string => {
      if (!format) return source
      if (format === "text") return isHtmlLike(contentType) ? pageText(source) : source
      return toMarkdown(source, contentType)
    }

    c.header("Access-Control-Allow-Origin", "*")
    c.header("X-Content-Type-Options", "nosniff")
    c.header("X-Derive-Version", String(v))
    c.header("X-Derive-Kind", artifact.kind)

    const manifest = await manifestOf(blobs, version)
    if (!manifest) {
      // Single-file artifact.
      const src = await sourceText(version)
      if (src === null) return fail(c, 500, "blob missing")
      if (outline) {
        c.header("X-Derive-Format", "outline")
        return c.json({ sections: outlineOf(src, version.content_type) })
      }
      if (section) {
        const slice = sectionOf(src, version.content_type, section)
        if (slice === null) return fail(c, 404, `no section "${section}"`)
        const body = present(slice, version.content_type)
        c.header("X-Derive-Format", format ?? "raw")
        c.header("X-Derive-Section", section)
        c.header("Content-Type", "text/plain; charset=utf-8")
        return c.body(body)
      }
      const body = present(src, version.content_type)
      c.header("X-Derive-Format", format ?? "raw")
      c.header("X-Derive-Sections", String(outlineOf(src, version.content_type).length))
      c.header("Content-Type", "text/plain; charset=utf-8")
      return c.body(body)
    }

    // Bundle.
    if (outline) {
      c.header("X-Derive-Format", "outline")
      return c.json({
        entry: cleanPath(manifest.entry),
        pages: Object.keys(manifest.files).map((p) => ({
          path: cleanPath(p),
          type: manifest.files[p]?.type,
        })),
      })
    }
    // Split on the LAST '#' — matches the MCP `read` tool's page#slug parsing, so a
    // page path/slug resolves to the same (pagePath, slug) pair on both surfaces.
    const hash = section ? section.lastIndexOf("#") : -1
    const pagePath =
      hash > 0 ? (section as string).slice(0, hash) : (section ?? cleanPath(manifest.entry))
    const slug = hash > 0 ? (section as string).slice(hash + 1) : null
    const file = manifest.files[pagePath] ?? manifest.files[`/${cleanPath(pagePath)}`]
    if (!file) return fail(c, 404, `no page "${pagePath}"`)
    const bytes = await blobs.get(file.key)
    if (!bytes) return fail(c, 500, "blob missing")
    const fileBaseType = file.type.split(";")[0]?.trim() ?? file.type
    const isText = fileBaseType === "text/html" || fileBaseType === "text/markdown"
    if (!isText) {
      // This route is a machine content API, not a rendering surface (unlike /raw/,
      // which applies a CSP sandbox to every bundle asset it serves). Native
      // Content-Type is safe for the SAFE set below; anything else — most notably
      // image/svg+xml, which a direct navigation renders as a scriptable document —
      // is served inert instead of trusting the stored type verbatim.
      c.header(
        "Content-Type",
        SAFE_BINARY_CONTENT_TYPES.has(fileBaseType) ? file.type : "application/octet-stream",
      )
      c.header("X-Derive-Format", "raw")
      return c.body(toBody(bytes))
    }
    const raw = new TextDecoder().decode(bytes)
    if (slug) {
      const slice = sectionOf(raw, file.type, slug)
      if (slice === null) return fail(c, 404, `no section "${slug}" in "${pagePath}"`)
      c.header("X-Derive-Format", format ?? "raw")
      c.header("X-Derive-Section", `${pagePath}#${slug}`)
      c.header("Content-Type", "text/plain; charset=utf-8")
      return c.body(present(slice, file.type))
    }
    c.header("X-Derive-Format", format ?? "raw")
    c.header("X-Derive-Section", pagePath)
    c.header("X-Derive-Sections", String(outlineOf(raw, file.type).length))
    c.header("Content-Type", "text/plain; charset=utf-8")
    return c.body(present(raw, file.type))
  })

  // Live editor preview: render a markdown draft to the exact published HTML.
  // Stateless (renders the caller's text, stores nothing) and signed-in only, so
  // it can't be used as an anonymous render farm. HTML drafts preview in the
  // browser, so this is markdown-only.
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/preview",
      tags: ["Artifacts"],
      summary: "Render a markdown draft to the exact published HTML (stateless; signed-in only).",
      responses: {
        200: {
          description: "The rendered HTML.",
          content: { "application/json": { schema: z.object({ html: z.string() }) } },
        },
      },
    }),
    async (c) => {
      if (!(await actingUser(c))) return bail(fail(c, 401, "unauthenticated"))
      const body = await readJson(
        c,
        z.object({ source: z.string().max(500_000), title: z.string().max(300).nullish() }),
      )
      if (body instanceof Response) return bail(body)
      return c.json({ html: await renderMarkdown(body.source, body.title ?? null) })
    },
  )

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
    // ?content=markdown diffs the readable form (HTML converted) instead of raw
    // source — kills tag noise and fixes minified one-line HTML producing a
    // single useless del/add pair. Default stays raw bytes for existing consumers.
    const ops =
      c.req.query("content") === "markdown"
        ? diffLines(toMarkdown(a, vf.content_type), toMarkdown(b, vt.content_type))
        : diffLines(a, b)

    c.header("Access-Control-Allow-Origin", "*")
    c.header("X-Derive-From", String(from))
    c.header("X-Derive-To", String(to))
    if (c.req.query("format") === "json") return c.json({ from, to, ops })
    c.header("Content-Type", "text/plain; charset=utf-8")
    return c.body(formatDiff(ops))
  })

  return app
}
