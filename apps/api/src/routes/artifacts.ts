import {
  type AnyDocEdit,
  type ArtifactRecord,
  artifactUrl,
  assertedOnly,
  type BundleDoc,
  type BundleManifest,
  bundleDoc,
  can,
  capRole,
  decodeCursor,
  diffLines,
  EditError,
  effectiveRole,
  elideDataUris,
  encodeCursor,
  formatDiff,
  groupSessions,
  hasArtifactStanding,
  heavyAssetsAdvisory,
  isHtmlLike,
  isLatexBundle,
  isLatexLike,
  isMarkdownBundle,
  LINKED_BUNDLE_CONTENT_TYPE,
  type LinkedBundleManifest,
  latexTextParts,
  maxRole,
  missingBlobAdvisory,
  newId,
  newShortId,
  outlineOf,
  PublishError,
  pageText,
  parseSortMode,
  publish,
  publishAdvisories,
  type Role,
  renderLatex,
  renderMarkdown,
  roleAllows,
  type SlideOp,
  sectionOf,
  slotShapeDriftAdvisories,
  slugify,
  sortKeyOf,
  toJson,
  toMarkdown,
  type VersionRecord,
  type WorkflowPreview,
  type WorkspaceAccess,
} from "@derive/core"
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { Context } from "hono"
import { setCookie } from "hono/cookie"
import type { BlankEnv } from "hono/types"
import type { AppContext } from "../context"
import { afterPublish } from "../lib/after-publish"
import {
  authorProfile,
  bylinesFrom,
  handlesFrom,
  resolveHandles,
  resolveUserBylines,
} from "../lib/author"
import { BULK_MAX, BulkSummarySchema, bulkArtifactOp } from "../lib/bulk"
import { cleanPath, manifestOf, mergeBundleZip } from "../lib/bundle"
import { signClaimToken, verifyClaimToken } from "../lib/claim-token"
import { contentMentionHandles, resolveContentMentionTargets } from "../lib/content-mentions"
import {
  bucketedNow,
  hashPassword,
  signState,
  unlockCookie,
  unlockToken,
  verifyPassword,
} from "../lib/crypto"
import { DRAFT_TTL_MS, DRAFTS_ORG_ID, sweepExpiredDrafts } from "../lib/drafts"
import {
  EditConflictError,
  type MaterializedEdits,
  materializeEdits,
  materializeSlideOps,
  parseBaseVersion,
} from "../lib/edits"
import {
  bail,
  DEFAULT_WORKSPACE_NAME,
  fail,
  legacyAccessOf,
  linkRoleOf,
  listedOf,
  MAX_UPLOAD_BYTES,
  RAW_TOKEN_MAX_AGE_MS,
  RAW_TOKEN_WINDOW_MS,
  readJson,
  str,
  TOMBSTONE,
  toBody,
  workspaceAccessOf,
} from "../lib/http"
import { bundleTextFiles } from "../lib/latex-bundle"
import { agentName } from "../lib/principal-kind"
import { PUBLISH_TARGET_CREATE, verifyPublishToken } from "../lib/publish-token"
import { agentPushFanout, openReviewRound } from "../lib/review-request"
import { type ReviewSummary, summarizeTextEdits } from "../lib/review-summary"
import {
  deleteArtifactAndUnindex,
  indexArtifactVersion,
  isTextType,
  searchArtifactVersion,
  searchMatcher,
  searchReport,
  searchWorkspace,
  toSearchHits,
  workspaceSearchReport,
} from "../lib/search"
import { normalizeTags, parseTagsField } from "../lib/tags"
import { parseLinkedWorkflowFacts } from "../lib/workflow-facts"
import { log } from "../log"
import { Artifact } from "../schemas"

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

/**
 * Attended inline saves are a working burst, not a trail of meaningful checkpoints.
 * Five minutes matches the product rule: a pause creates the next durable version.
 */
const INLINE_EDIT_COALESCE_MS = 5 * 60_000

/** The artifact lifecycle: browse + summary, publish/republish, detail, restore,
 *  source read-back, and version diffs. */
export const artifactRoutes = (ctx: AppContext) => {
  const {
    meta,
    blobs,
    search,
    summarize,
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
    actingHuman,
    privateOwnerId,
    activeWorkspace,
    membershipOf,
    actorFor,
    agentFor,
    authorize,
    authorizeStanding,
    authorizeUserStanding,
    resolveArtifact,
    requireArtifact,
    resolveArtifacts,
    workspaceCan,
    collectionRole,
    limited,
    overStorage,
    billingGate,
    blockCopy,
    effectiveWhiteLabel,
    publishLimiter,
    unlockLimiter,
    sourceText,
  } = ctx
  const app = new OpenAPIHono<BlankEnv>()

  // Keyset-paginated (?sort=&cursor=&limit=N; the cursor is keyed on the active sort —
  // see sortKeyOf), with optional server-side ?query= (artifact title, tag, or
  // collection-title search), ?tag=, and ?favorite=true. Returns { artifacts,
  // next_cursor }. tag/favorite resolve to an id set first.
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/artifacts",
      tags: ["Artifacts"],
      summary:
        "List artifacts (keyset-paginated; ?sort=/query=/tag=/collection=/scope=/author=/favorite=; cursor keyed on the active sort).",
      responses: {
        200: {
          description: "A page of artifacts + next cursor (+ the collection when scoped to one).",
          content: {
            "application/json": {
              schema: z.object({
                artifacts: z.array(Artifact),
                next_cursor: z
                  .string()
                  .nullable()
                  .describe("Opaque cursor for the next page; null on the last page."),
                collection: z
                  .object({ id: z.string(), title: z.string() })
                  .optional()
                  .describe("The scoped collection; present only when listing one (?collection=)."),
              }),
            },
          },
        },
      },
    }),
    async (c) => {
      const me = await currentUser(c)
      const requestedCollection = c.req.query("collection")?.trim() || undefined
      // Registered/OAuth agents list too — their library is how MCP list_artifacts
      // finds work. Anonymous listing is allowed only through one explicitly named,
      // authorized collection world link; the workspace library remains closed.
      const agent = me ? null : await agentFor(c)
      if (!me && !agent && !isToken(c) && !requestedCollection)
        return bail(fail(c, 401, "unauthenticated"))
      // Whose member rows count. Listing must mirror can(read): an agent derives
      // its standing from its registrant's rows (capped at its registered role —
      // see actorFor), so a linked agent's key is the REGISTRANT; an agent with
      // no registrant on record falls back to its own legacy rows.
      const memberKey = me?.id ?? agent?.created_by ?? agent?.id ?? null
      const limit = Math.min(100, Math.max(1, Number(c.req.query("limit")) || 30))
      // Opaque compound cursor "<key>|<id>" — the id tiebreak keeps paging
      // correct when many artifacts share a key.
      const cursor = decodeCursor(c.req.query("cursor"))
      // Unknown/absent ?sort= falls back to the default — never errors. The ROUTE default
      // is "created" (not parseSortMode's feature default "updated"): the library always
      // sends an explicit ?sort=, so every OTHER caller (command palette, home strips) must
      // keep the historical created-desc ordering when no ?sort= is given.
      const sort = parseSortMode(c.req.query("sort") ?? "created")
      // Cap the search term: it goes into a SQL LIKE, and an oversized value tripped
      // an unhandled DB error (a long-q 500). No real metadata search needs > 200 chars.
      const q = c.req.query("query")?.trim().slice(0, 200) || undefined
      const tag = c.req.query("tag")?.trim() || undefined
      const collectionId = requestedCollection
      const favOnly = c.req.query("favorite") === "true"
      // ?author=<github login> narrows to artifacts whose current author is that login.
      const author = c.req.query("author")?.trim().slice(0, 100) || undefined
      const archivedOnly = c.req.query("scope") === "archived"

      // The FAVORITES FEED needs the star list before the list query, because it narrows
      // by it. Every other listing only needs to know which rows on the page it got back
      // are starred — and that now rides `listEnrichment` as one more arm keyed on the
      // same page of ids, so the common case no longer opens with a round trip of its
      // own. On the edge tier that is ~80ms off the request the library boot waits on.
      const favIds = me && favOnly ? await meta.listUserFavoriteIds(me.id) : []
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
      const activeOrg = await activeWorkspace(c)
      let listOrg = activeOrg
      let collectionAccess = false
      let collectionScopeRole: Role | null = null
      // Carry the collection's title so the client can label the view even when the
      // collection lives in another workspace (it's absent from the local sidebar list).
      // Only for a caller who actually has access — otherwise the title (and the fact
      // this id resolves at all) leaks to anyone who can guess/pass a collectionId.
      let collectionInfo: { id: string; title: string } | undefined
      if (collectionId) {
        const col = await meta.getCollection(collectionId)
        if (!col) return c.json({ artifacts: [], next_cursor: null })
        // Scope to the collection via a JOIN in listArtifacts (below), NOT by expanding
        // its members into an id IN(): a large collection (hundreds of items) would blow
        // D1's 100-bound-parameter cap and 500 the whole listing.
        listOrg = col.org_id
        // collectionRole is the single source of truth (it already folds in the workspace
        // seat, conditionally on the collection's OWN workspace_access — see context.ts):
        // plain isMember(org) would grant access to an Invited-only collection to every
        // workspace member, defeating the toggle entirely.
        collectionScopeRole = await collectionRole(c, col)
        collectionAccess = collectionScopeRole !== null
        if (!collectionAccess) {
          // A live password link is discoverable-but-locked so the public page
          // can render its gate. Private collections preserve the historical
          // empty feed and leak neither title nor items.
          if (col.password_hash && col.link_role !== "none")
            return bail(fail(c, 401, "password required"))
          return c.json({ artifacts: [], next_cursor: null })
        }
        if (collectionAccess) collectionInfo = { id: col.id, title: col.title }
      }
      // Author filter narrows to artifacts last changed by a GitHub login, scoped to the
      // listing's workspace (after collection scope has settled listOrg). Mirrors ?tag=.
      if (author) narrow(await meta.artifactIdsByAuthor(listOrg, author))
      if (ids && ids.length === 0) return c.json({ artifacts: [], next_cursor: null })

      // The caller's baseline standing in the listing's workspace — reused for the
      // public-only clamp below and the per-row `my_role` (which needs the ROLE, so
      // the boolean isMember helper doesn't fit). Workspace seats only apply when
      // this is also the active workspace. A portable collection share can make a
      // foreign collection the listing scope, but must not bring that workspace's
      // seat along with it (the same scoping actorFor applies).
      const isOperator = isToken(c)
      const baselineRole =
        listOrg !== activeOrg
          ? null
          : me
            ? ((await membershipOf(c, listOrg, me.id))?.role ?? null)
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
      const listOpts = {
        limit: limit + 1,
        cursor,
        sort,
        q,
        // Collection titles are searchable only when this caller can see that
        // collection. Artifact titles/tags already ride the artifact visibility gate.
        collectionSearchViewerId: isOperator ? undefined : memberKey,
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
        // the operator token sees everything (viewerId omitted). Collection access is
        // access to the WHOLE collection — a member/creator/seat-on-a-workspace-open
        // collection reaches every item in it (matching collectionRolesForArtifact's
        // propagation), so within a collection scope we drop the per-artifact filter
        // (the collectionId JOIN already bounds the results). Without this the count
        // (all items) would outrun the list (only your explicitly-shared items).
        viewerId:
          isOperator || (collectionId && collectionAccess) ? undefined : (memberKey ?? undefined),
        archived: archivedOnly ? ("only" as const) : ("exclude" as const),
      }
      // THE COLD BOOT'S CRITICAL PATH. After the rest of this PR, nothing is queued in
      // front of this request any more — the first card paints 43ms after it lands — so
      // its own round trips are the whole remaining cost. The list and its decoration are
      // strictly serial (the decoration keys on the ids the list returns), and `listPage`
      // answers both in one statement on a store that can. Optional: the embedded drivers
      // do not implement it and take the two calls below unchanged.
      const combined = meta.listPage
        ? await meta.listPage({
            list: listOpts,
            viewerId: me?.id ?? null,
            memberId: memberKey,
            views: analyticsOn,
          })
        : null
      const rows = combined?.artifacts ?? (await meta.listArtifacts(listOpts))
      const hasMore = rows.length > limit
      const page = hasMore ? rows.slice(0, limit) : rows
      const last = page[page.length - 1]
      const next_cursor = hasMore && last ? encodeCursor(sortKeyOf(last, sort), last.id) : null

      // ALL of the page's decoration — view counts, tags, preview readiness, author
      // handles + bylines (the self-heal for stale agent-client names), the viewer's
      // comment signals, and the viewer's per-artifact share
      // roles (for a linked agent these are the registrant's rows, so the cap
      // applies) — in ONE store round trip. These are seven trivial lookups keyed on
      // the same page of ids; issued separately, each one was a full ~80ms edge→
      // Postgres round trip (see edge-pg.ts), which made the decoration cost more
      // than the list query itself.
      const enrichment =
        combined?.enrichment ??
        (await meta.listEnrichment({
          ids: page.map((a) => a.id),
          ghIds: [...new Set(page.map((a) => a.author_gh_id).filter((x): x is string => !!x))],
          authorIds: [...new Set(page.map((a) => a.author_id).filter((x): x is string => !!x))],
          viewerId: me?.id ?? null,
          memberId: memberKey,
          views: analyticsOn,
        }))
      const counts = enrichment.views
      const tags = enrichment.tags
      const collectionsById = enrichment.collections
      const previews = enrichment.previews
      const handleByGhId = handlesFrom(enrichment.handles)
      const bylineByUserId = bylinesFrom(enrichment.bylines)
      const feedback = enrichment.signals
      const shareRoles = enrichment.shareRoles
      const scopedShareRole = (artifact: ArtifactRecord): Role | null => {
        const role = shareRoles[artifact.id] ?? null
        return artifact.org_id === activeOrg || role !== "owner" ? role : null
      }
      // Page-scoped and taken from the batch, for BOTH paths — including the favorites
      // feed, whose `favIds` above is a narrowing input, not the row decoration. One
      // source of truth means the star a row renders can't disagree with the star the
      // enrichment saw.
      const favorites = new Set(enrichment.favorites)
      return c.json({
        artifacts: page.map((a) => ({
          ...toJson(deps.baseUrl, a, []),
          views: counts[a.id] ?? 0,
          tags: tags[a.id] ?? [],
          // The library's grouped-by-collection list groups on this. Same batched read
          // as everything else on the row — see ListEnrichment.collections.
          collections: collectionsById[a.id] ?? [],
          favorite: favorites.has(a.id),
          has_preview: previews[a.id] === true,
          // Which actions the client may surface on the row (the card's quick-actions
          // menu gates delete/tags on it). A collection-scoped listing has already
          // resolved the caller's role on that collection, so fold the same grant into
          // every item instead of rendering cards weaker than their detail pages.
          my_role: isOperator
            ? "owner"
            : (collectionScopeRole ??
              effectiveRole(
                memberKey
                  ? {
                      kind: "user",
                      userId: memberKey,
                      artifactRole:
                        agent?.created_by != null
                          ? capRole(scopedShareRole(a), agent.role)
                          : scopedShareRole(a),
                      orgRole: a.org_id === activeOrg ? baselineRole : null,
                    }
                  : { kind: "anon" },
                a.workspace_access,
                a.link_role,
              )),
          // The current author as a resolved profile (name/login/avatar + Derive handle), so
          // the list can render the last editor + filter by them.
          author: authorProfile(a, handleByGhId, bylineByUserId),
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
                total: z.number().describe("Total artifacts in the workspace."),
                archived: z.number().describe("Artifacts on the reversible archive shelf."),
                favorites: z.number().describe("The caller's favorite count in this workspace."),
                mine: z.number().describe("Count of artifacts the caller owns ('Created by me')."),
                mine_private: z
                  .number()
                  .describe("Owned artifacts not surfaced anywhere yet (listed=none)."),
                tags: z
                  .array(z.object({ tag: z.string(), count: z.number() }))
                  .describe("Per-tag artifact counts for the workspace."),
                workspace: z
                  .string()
                  .nullable()
                  .describe("Workspace display name; null for a non-member (empty summary)."),
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
          archived: 0,
          favorites: 0,
          mine: 0,
          mine_private: 0,
          tags: [],
          workspace: null,
        })
      // The sidebar's whole summary in ONE store call. These were six reads all scoped
      // to this workspace (or this workspace + caller) — six ~80ms round trips on the
      // edge for one sidebar. Semantics preserved by workspaceSummary: `favorites`
      // counts only THIS workspace's live artifacts (a favorite in another workspace, or
      // of a removed one, must not inflate the badge), and `mine`/`mine_private` key on
      // the OWNER member row rather than the author_id denorm. `favorites` is also now a
      // count rather than a whole id list the route only took `.length` of.
      const summary = await meta.workspaceSummary(org, me?.id ?? null)
      const tags = [...summary.tags].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
      return c.json({
        total: summary.total,
        archived: summary.archived,
        favorites: summary.favorites,
        mine: summary.mine,
        mine_private: summary.minePrivate,
        tags,
        workspace: summary.workspace ?? DEFAULT_WORKSPACE_NAME,
      })
    },
  )

  // ---- Publish ----------------------------------------------------------

  // `tokenAuth`, when present, is a caller the MCP stage_publish tool authorized
  // out-of-band with a short-lived capability token (see lib/publish-token.ts):
  // the route already verified the token, re-checked the user's live membership,
  // and confirmed the target scope, so this skips the per-request auth and acts
  // AS the bound user for attribution + ownership. Everything downstream —
  // quota, body handling, access resolution, the publish itself — is shared with
  // the session/bearer path, so a tokened publish behaves identically.
  const handlePublish = async (
    c: Context,
    shortId?: string,
    tokenAuth?: {
      org: string
      // null = the anonymous draft mint (POST /v1/drafts): no principal exists, so
      // the artifact is created ownerless — author "anonymous", author_id null, no
      // member row (the same supported state deleteUserData leaves behind). Only
      // ever null together with `draft`, and only for a CREATE.
      user: { id: string; name: string | null } | null
      // The agent that minted the staged upload URL (the hosted MCP flow), when one did:
      // the version is recorded as that agent's work on the user's behalf.
      agent?: { id: string; name: string } | null
      // Present on the draft path: forces the draft access shape (link-viewable,
      // nothing else — the URL is the whole product until it's claimed) and stamps
      // the expiry. Client-supplied access fields are ignored: an anonymous caller
      // must not be able to list a draft anywhere or lock it with a password.
      draft?: { expiresAt: string }
    },
  ) => {
    const requestStartedAt = performance.now()
    const tokenUser = tokenAuth ? tokenAuth.user : null
    // Republishing a version needs publish rights on that artifact; creating a
    // new one needs publish rights at the workspace level.
    let existing: ArtifactRecord | null = null
    if (shortId) {
      existing = await meta.getByShortId(shortId)
      if (!existing) return fail(c, 404, "not found")
      // A tokened caller is scoped to this artifact's workspace by the token's
      // own org; refuse if the artifact lives elsewhere, so a token minted for
      // one workspace can never revise another's artifact via a shared short_id.
      if (tokenAuth && existing.org_id !== tokenAuth.org) return fail(c, 403, "forbidden")
      // Publish rights on an EXISTING artifact are artifact-level standing (an
      // explicit/collection share + workspace seat), NOT the workspace seat alone
      // — on a private artifact the seat grants nothing, only the share counts. The
      // session path resolves that from the request; the tokened path resolves the
      // SAME standing for the bound user, live (revocation-safe). Checking only the
      // seat here would let a workspace editor with a mere viewer share overwrite a
      // private doc — an escalation the authed API forbids.
      // An anonymous (userless) token can only CREATE — there is no standing to
      // revise anything, so a userless revise fails closed here.
      const publishOk = tokenAuth
        ? tokenUser
          ? await authorizeUserStanding(tokenUser.id, "publish", existing)
          : false
        : await authorize(c, "publish", existing)
      if (!publishOk) return fail(c, 403, "forbidden")
      // Locked: even an editor can't publish directly. The lock is a freeze — comment
      // with the suggested change, or unlock to publish.
      if (existing.locked)
        return fail(c, 409, "artifact is locked — unlock it to publish, or leave a comment")
    } else if (!tokenAuth && !(await workspaceCan(c, "publish"))) {
      return fail(c, 403, "forbidden")
    }
    // Quotas are per-workspace: a republish counts against the artifact's own
    // org, a new artifact against the caller's active workspace (or, for a
    // tokened create, the workspace the token was minted for).
    const org = existing ? existing.org_id : tokenAuth ? tokenAuth.org : await activeWorkspace(c)
    const blocked = await billingGate(c, org)
    if (blocked) return blocked
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
    // `slide_ops` — structural intent on a deck (move/delete/duplicate/insert a slide by
    // position), materialized against the stored source the same way `edits` is. Its own
    // field because a slide move is not a text replacement: the text pipelines refuse
    // spans that cross element boundaries, and expressing it as search/replace means
    // shipping two byte-perfect copies of the slide.
    const slideOpsField = body["slide_ops"]
    let bytes: Uint8Array
    let filename: string
    let isBundle: boolean
    let preparedSource: string | undefined
    // An edit inside a paper bundle republishes the bundle; its SPA flag is kept as is.
    let bundleSpa: boolean | undefined
    let editSummary: ReviewSummary | undefined
    let previousSearchSource:
      | { source: string; contentType: string | null; title: string | null }
      | undefined
    if (typeof editsField === "string" || typeof slideOpsField === "string") {
      if (typeof editsField === "string" && typeof slideOpsField === "string")
        return fail(c, 400, "Provide `edits` OR `slide_ops`, not both")
      const structural = typeof slideOpsField === "string"
      const field = structural ? "slide_ops" : "edits"
      if (!shortId || !existing)
        return fail(
          c,
          400,
          `${field} revises an EXISTING artifact — POST to its /versions endpoint`,
        )
      let parsed: AnyDocEdit[] | SlideOp[]
      try {
        parsed = JSON.parse((structural ? slideOpsField : editsField) as string)
      } catch {
        return fail(
          c,
          400,
          structural
            ? "slide_ops must be a JSON array of {op,...}"
            : "edits must be a JSON array of {old_str,new_str}",
        )
      }
      let materialized: MaterializedEdits
      try {
        const baseVersion = parseBaseVersion(str(body["base_version"]))
        const deps = {
          getVersion: meta.getVersion.bind(meta),
          sourceText,
          captureSource: (source: string, contentType: string | null) => {
            previousSearchSource = { source, contentType, title: existing.title }
          },
          manifestOf: (v: VersionRecord) => manifestOf(blobs, v),
          bundleTexts: (m: BundleManifest) => bundleTextFiles(blobs, m),
        }
        materialized = structural
          ? await materializeSlideOps(deps, existing, parsed as SlideOp[], baseVersion)
          : await materializeEdits(deps, existing, parsed as AnyDocEdit[], baseVersion)
      } catch (e) {
        if (e instanceof EditConflictError) return fail(c, 409, e.message)
        return fail(
          c,
          e instanceof EditError ? 400 : 500,
          e instanceof Error ? e.message : "edit failed",
        )
      }
      if (materialized.bundle) {
        // One file of a paper bundle changed: the new version is the whole bundle with
        // that file replaced, so its siblings (.bib, sections, figures) carry over.
        bytes = await mergeBundleZip(blobs, materialized.bundle.manifest, {
          [materialized.bundle.path]: materialized.content,
        })
        bundleSpa = materialized.bundle.manifest.spa
      } else {
        bytes = new TextEncoder().encode(materialized.content)
        preparedSource = materialized.content
      }
      if (!structural) {
        const applied = parsed as AnyDocEdit[]
        const textEdits = applied.flatMap((edit) => {
          if ("old_str" in edit)
            return [
              {
                before: edit.old_str,
                after: edit.new_str,
                contentType: materialized.filename.endsWith(".md")
                  ? "text/markdown"
                  : materialized.filename.endsWith(".tex")
                    ? "text/x-latex"
                    : "text/html",
              },
            ]
          if ("quote" in edit && typeof edit.new_text === "string")
            return [
              {
                before: edit.quote.exact,
                after: edit.new_text,
                contentType: "text/markdown",
              },
            ]
          return []
        })
        if (textEdits.length === applied.length)
          editSummary = summarizeTextEdits({
            edits: textEdits,
            fromVersion: existing.current_version,
            toVersion: existing.current_version + 1,
            note: str(body["message"]),
          })
      }
      if (bytes.length > MAX_UPLOAD_BYTES) return fail(c, 413, "upload too large")
      if (await overStorage(org, bytes.length))
        return fail(c, 413, blockCopy.storage.message, { code: blockCopy.storage.code })
      filename = materialized.bundle ? "paper.zip" : materialized.filename
      isBundle = !!materialized.bundle
    } else {
      const file = body["file"]
      if (!(file instanceof File)) return fail(c, 400, "multipart field 'file' required")
      bytes = new Uint8Array(await file.arrayBuffer())
      // The content-length header is advisory (a client can omit/understate it),
      // so re-check the actual buffered size — the hard cap before anything stores.
      if (bytes.length > MAX_UPLOAD_BYTES) return fail(c, 413, "upload too large")
      if (await overStorage(org, bytes.length))
        return fail(c, 413, blockCopy.storage.message, { code: blockCopy.storage.code })
      filename = file.name
      isBundle =
        /\.zip$/i.test(file.name) ||
        body["kind"] === "bundle" ||
        (bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 3 || bytes[2] === 5))
      if (!isBundle) preparedSource = new TextDecoder().decode(bytes)
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
      // The authenticated principal behind this publish (signed-in user or agent). The
      // Derive-USER behind it is what we attribute work to: for an agent, the human it acts
      // on behalf of (created_by / the OAuth grantor). `author_id` keys a person's profile +
      // their followers' feed, so it must be a real user id, never an agent principal.
      // `human` is that same person as a byline — so a delegated publish reads as them, not
      // as the agent's own name ("Derive CLI", "Claude", or whatever client/model drove it;
      // authored work is the person's, and which tool typed it is an implementation detail).
      // `actor` is only the fallback for an ownerless principal (a pre-column agent).
      // A tokened publish acts AS the bound user: they are the author byline, the
      // author_id (their profile/feed), and the private owner — the same identity
      // the session/bearer path resolves from the request, just supplied by the
      // token instead. A tokened publish behaves like that user's OWN publish (they
      // drove it and get the artifact URL back in the curl response), so — like a
      // session publish, and unlike the agent `publish` tool — it has no agent
      // principal and fires no "your agent published X" bell to onBehalf.
      const actor = tokenAuth ? tokenUser : await actingUser(c)
      const human = tokenAuth ? tokenUser : await actingHuman(c)
      const onBehalf = tokenAuth ? (tokenUser?.id ?? null) : await privateOwnerId(c)
      const agentPrincipal = tokenAuth ? null : await agentFor(c)
      // THE AGENT-WRITE SWITCH binds every agent-credentialed publish, not only the hosted
      // claims: a workspace that switched agents off must not take a live write from a
      // standing agent bearer, and not from a staged publish URL either — the mint refuses
      // too, but a token can outlive a flip, so the spend re-checks. A person's own publish
      // (session, or an anonymous draft) is untouched — the switch is about agents, and
      // fails CLOSED on a read error. The settings row is kept for the brand-profile check
      // further down.
      const agentCredentialed = !!agentPrincipal || (!!tokenAuth && !tokenAuth.draft)
      const agentSettings = agentCredentialed
        ? await meta.getOrgSettings(org).catch(() => null)
        : null
      if (agentCredentialed && !agentSettings?.agentWrites)
        return fail(
          c,
          403,
          "this workspace has agent writes switched off — leave the change as a comment for a person to apply",
        )
      // The brand profile's forced review round (below) needs a human to attribute it to.
      // An OWNERLESS agent bearer targeting the profile is refused before the write —
      // matching the MCP surface — rather than publishing the one document that steers
      // every agent with no round behind it.
      if (
        agentCredentialed &&
        !onBehalf &&
        existing &&
        agentSettings?.brandprint?.profileId === existing.short_id
      )
        return fail(
          c,
          403,
          "publishing the brand profile needs a user to attribute its review to — use a grant bound to a user",
        )
      // The web inline editor marks small attended saves as coalescible. Replace only
      // the same person's unreviewed current web version, and only during a short
      // burst. Named checkpoints, API/MCP writes, comments, review rounds, and a
      // five-minute pause all force the normal append-only path.
      let replaceCurrent: { n: number; blobKey: string } | undefined
      const coalesceRequested =
        typeof editsField === "string" &&
        (body["coalesce"] === "true" || body["coalesce"] === "1") &&
        !str(body["name"]) &&
        body["request_review"] !== "true" &&
        body["request_review"] !== "1" &&
        !str(body["resolves"])
      if (coalesceRequested && existing && onBehalf && !agentPrincipal) {
        const current = await meta.getVersion(existing.id, existing.current_version)
        const age = current ? Date.now() - Date.parse(current.created_at) : Number.POSITIVE_INFINITY
        if (
          current &&
          current.author_id === onBehalf &&
          current.source === "web" &&
          !current.name &&
          age >= 0 &&
          age <= INLINE_EDIT_COALESCE_MS
        ) {
          const [comments, rounds] = await Promise.all([
            meta.listComments(existing.id),
            meta.listReviewRounds(existing.id),
          ])
          const hasFeedback = comments.some((comment) => comment.base_version === current.n)
          const hasReview = rounds.some((round) => round.version === current.n)
          if (!hasFeedback && !hasReview)
            replaceCurrent = { n: current.n, blobKey: current.blob_key }
        }
      }
      // Access is set-on-create: a republish never re-stamps it (publish() only adds a
      // version). On a NEW artifact each field resolves independently — explicit request
      // field > legacy `visibility` mapping > the workspace default (factory default is
      // the "team draft": workspace_access=member, link_role=none, listed=none). One
      // org-settings read covers all three defaults.
      // A draft's access shape is fixed, never client-resolved: the URL is the only
      // grant (link-viewer), it surfaces nowhere, and the holding workspace's members
      // get nothing. Cross-origin serving on the usercontent host REQUIRES the viewer
      // link (the actor there is anonymous), so this is the product shape, not a default.
      const draft = tokenAuth?.draft
      const settings = !shortId && !draft ? await meta.getOrgSettings(org) : null
      const resolvedWorkspaceAccess = !shortId
        ? draft
          ? "none"
          : (workspaceAccess ?? legacy?.workspace_access ?? settings?.defaultWorkspaceAccess)
        : undefined
      const resolvedLinkRole = !shortId
        ? draft
          ? "viewer"
          : (linkRole ?? legacy?.link_role ?? settings?.defaultLinkRole)
        : undefined
      const resolvedListed = !shortId
        ? draft
          ? "none"
          : (listed ?? legacy?.listed ?? settings?.defaultListed)
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
        resolvedLinkRole && resolvedLinkRole !== "none" && password && !draft
          ? await hashPassword(password)
          : undefined
      const coreStartedAt = performance.now()
      const {
        artifact,
        version,
        timings: publishTimings,
      } = await publish(
        meta,
        blobs,
        {
          bytes,
          filename,
          isBundle,
          title: str(body["title"]),
          slug: str(body["slug"]),
          spa: bundleSpa ?? (body["spa"] === "true" || body["spa"] === "1"),
          message: str(body["message"]),
          // Author is the authenticated identity, never a client-supplied field — a
          // logged-in publish must be attributed to that person. The human behind the
          // request wins (a signed-in user, or the CLI / MCP grantor), so a delegated
          // publish reads as the person; a registered agent falls back to its own name.
          // Anonymous callers can't reach this route at all, so a publish is always
          // attributed to a real principal (the token's optional `author` label is the
          // one headless exception). A TOKENED publish is bound to a known user, so it
          // uses their name and never the client `author` field — otherwise a caller
          // could stamp an arbitrary byline whenever that user's stored name is null.
          author: tokenAuth
            ? (tokenUser?.name ?? undefined)
            : (human?.name ?? actor?.name ?? str(body["author"])),
          authorId: onBehalf,
          // THE ACTOR: the agent principal behind this request (a registered agent, an
          // OAuth client, the CLI), or the agent that minted a staged upload URL. A
          // person's own session publish records none. `author`/`author_id` stay the
          // person's — this is who did the work, for the activity record.
          agentId: agentPrincipal?.id ?? tokenAuth?.agent?.id ?? null,
          agentName: agentPrincipal?.name ?? tokenAuth?.agent?.name ?? null,
          // The surface stamp: a stage_publish token IS the MCP flow's upload leg, an
          // agent principal (OAuth bearer / dk_agt_ token, incl. the CLI) is the API,
          // and a plain session publish is the web app.
          source: tokenAuth ? (draft ? "api" : "mcp") : agentPrincipal ? "api" : "web",
          replaceCurrent,
          name: str(body["name"]),
          orgId: org,
          workspaceAccess: resolvedWorkspaceAccess,
          passwordHash,
          linkRole: resolvedLinkRole,
          listed: resolvedListed,
          expiresAt: draft?.expiresAt,
          ...(existing ? { existingArtifact: existing } : {}),
        },
        shortId,
      )
      const coreFinishedAt = performance.now()
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
      // Republish can resolve comment threads in the same call: map the given comment
      // ids to their threads, keeping only ones that belong to this artifact.
      const toResolve: string[] = []
      const resolves = body["resolves"]
      if (shortId && typeof resolves === "string" && resolves) {
        for (const cid of resolves
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)) {
          const cm = await meta.getComment(cid)
          if (cm && cm.artifact_id === artifact.id) toResolve.push(cm.thread_id)
        }
      }
      // Webhook + follower fan-out + thread resolves + realtime/render/re-anchor, all via
      // the one shared helper so this path can never drift from MCP publish or restore.
      const afterPublishStartedAt = performance.now()
      const { storedRows } = await afterPublish(
        {
          meta,
          blobs,
          bus,
          notify,
          notifyRender,
          background,
          search,
          summarize,
          baseUrl: deps.baseUrl,
        },
        artifact,
        version,
        {
          isNew: !shortId,
          onBehalf,
          resolves: toResolve,
          // The ACTING principal — an agent's own id (a bearer's, or the one that minted a
          // staged upload URL), not the human it acts for. `onBehalf` (and therefore
          // version.author_id) is deliberately the human, so it can't classify who published.
          actorId: agentPrincipal?.id ?? tokenAuth?.agent?.id ?? actor?.id ?? null,
          actorName: agentPrincipal?.name ?? tokenAuth?.agent?.name ?? actor?.name ?? null,
          ...(preparedSource !== undefined ? { preparedSource } : {}),
          ...(previousSearchSource ? { previousSearchSource } : {}),
        },
      )
      const afterPublishFinishedAt = performance.now()
      // Tag at publish time — the one-step "auto-tag on create/version" hook. `tags` is a
      // JSON array or a comma/space list on the multipart body; an editor can set it (the
      // publisher already holds publish standing on this artifact by having written the
      // version). An empty string clears; an absent field leaves tags untouched, so a
      // republish that doesn't mention tags keeps them.
      const parsedTags = parseTagsField(body["tags"])
      if (parsedTags !== null) await meta.setArtifactTags(artifact.id, normalizeTags(parsedTags))
      // `add_tags` is the ADDITIVE variant: union with whatever's already on the artifact,
      // never a replace. This is the platform-side stamp for automation tag-targets — the
      // executor passes the run's tag labels here so stamping is deterministic (the model
      // never has to remember), and a stamp can't wipe tags a human curated.
      const addTags = parseTagsField(body["add_tags"])
      if (addTags !== null && addTags.length > 0) {
        const current = (await meta.tagsForArtifacts([artifact.id]))[artifact.id] ?? []
        await meta.setArtifactTags(artifact.id, normalizeTags([...current, ...addTags]))
      }
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
          await openReviewRound(
            { meta, blobs, bus, baseUrl: deps.baseUrl, notify, pokeWebhooks: deps.pokeWebhooks },
            artifact,
            {
              reviewer,
              // The asker is the AGENT behind the publish: the bearer's principal (actor)
              // or the one that minted a staged upload URL — never the person the round
              // is for.
              requestedById: tokenAuth?.agent?.id ?? actor?.id ?? "agent",
              requestedByName: tokenAuth?.agent?.name ?? actor?.name ?? "An agent",
              version: version.n,
              note: str(body["review_note"]) ?? null,
              actorId: agentPrincipal?.id ?? actor?.id ?? null,
              ...(editSummary ? { summary: editSummary } : {}),
            },
          )
          roundCreated = true
        }
      }
      // THE BRAND PROFILE: an agent-credentialed write to it ALWAYS opens a round, asked for
      // or not — it steers every agent in the workspace, so its reveal is never silent. The
      // same invariant the MCP publish tool enforces, held here so this route is not the
      // side door around it. An attended person's own edit is itself the human moment and
      // opens nothing.
      if (
        !roundCreated &&
        agentPrincipal &&
        onBehalf &&
        agentSettings?.brandprint?.profileId === artifact.short_id
      ) {
        await openReviewRound(
          { meta, blobs, bus, baseUrl: deps.baseUrl, notify, pokeWebhooks: deps.pokeWebhooks },
          artifact,
          {
            reviewer: onBehalf,
            requestedById: agentPrincipal.id,
            requestedByName: agentPrincipal.name,
            version: version.n,
            actorId: agentPrincipal.id,
            ...(editSummary ? { summary: editSummary } : {}),
          },
        )
        roundCreated = true
      }
      // The MCP loop over HTTP: an AGENT-credentialed publish (a registered
      // dk_agt_ token or an OAuth bearer — the CLI and stdio-shim paths) reaches
      // its human exactly like the /mcp path does — the shared bell + auto-open
      // fan-out. A signed-in human's own save gets none of this — they're
      // already looking at it.
      const responseText =
        artifact.kind === "file" && isTextType(version.content_type)
          ? new TextDecoder().decode(bytes)
          : null
      const receiptDurations: Record<string, number> = {}
      const timedReceipt = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
        const startedAt = performance.now()
        try {
          return await work()
        } finally {
          receiptDurations[name] = performance.now() - startedAt
        }
      }
      // Advisories over what was just stored (missing viewport meta, oversized
      // inline base64, expiring upload URLs, page-markup-as-markdown, broken blob
      // refs) — computed server-side so every client relays the same guidance; the
      // boundary rules keep @derive/core out of the clients.
      const [openedInTab, versions, blobAdvisory, weightAdvisory, driftAdvisories] =
        await Promise.all([
          timedReceipt("push", () =>
            agentPrincipal && onBehalf
              ? agentPushFanout(
                  { meta, blobs, bus, baseUrl: deps.baseUrl, pokeWebhooks: deps.pokeWebhooks },
                  artifact,
                  {
                    user: onBehalf,
                    agentId: agentPrincipal.id,
                    agentName: agentPrincipal.name,
                    version: version.n,
                    reviewRound: roundCreated,
                    isNew: !shortId,
                    ...(editSummary ? { summary: editSummary } : {}),
                  },
                )
              : Promise.resolve(null),
          ),
          timedReceipt("versions", () => meta.listVersions(artifact.id)),
          timedReceipt("blob-check", () =>
            responseText ? missingBlobAdvisory(responseText, blobs) : Promise.resolve(null),
          ),
          timedReceipt("asset-weight", () =>
            responseText ? heavyAssetsAdvisory(responseText, meta) : Promise.resolve(null),
          ),
          timedReceipt("fact-drift", () =>
            responseText
              ? slotShapeDriftAdvisories(
                  responseText,
                  version.content_type,
                  artifact.id,
                  version.n - 1,
                  meta,
                )
              : Promise.resolve([]),
          ),
        ])
      const advisoryStartedAt = performance.now()
      const advisories = responseText
        ? [
            ...publishAdvisories(responseText, version.content_type),
            ...(blobAdvisory ? [blobAdvisory] : []),
            ...(weightAdvisory ? [weightAdvisory] : []),
            ...driftAdvisories,
          ]
        : []
      receiptDurations["advisories"] = performance.now() - advisoryStartedAt
      // What extraction actually STORED, returned by the successful write rather than echoed
      // from the parser — so a persistence failure reads as an empty list, not a false claim.
      // assertedOnly: this 201 body is the REST publish receipt, and the rows now include
      // the host's own $facts — a receipt listing $stats beside the author's numbers is
      // the host congratulating itself, the exact thing the reward surfaces must not do.
      const storedSlots = assertedOnly(storedRows)
      const responseStartedAt = performance.now()
      const duration = (value: number) => Math.max(0, value).toFixed(1)
      c.header(
        "Server-Timing",
        [
          `prepare;dur=${duration(coreStartedAt - requestStartedAt)}`,
          `blob-put;dur=${duration(publishTimings.blobWriteMs)}`,
          `store-content;dur=${duration(publishTimings.storeContentMs)}`,
          `metadata;dur=${duration(
            coreFinishedAt - coreStartedAt - publishTimings.storeContentMs,
          )}`,
          `after-publish;dur=${duration(afterPublishFinishedAt - afterPublishStartedAt)}`,
          `post-publish;dur=${duration(responseStartedAt - afterPublishFinishedAt)}`,
          `receipt-push;dur=${duration(receiptDurations["push"] ?? 0)}`,
          `receipt-versions;dur=${duration(receiptDurations["versions"] ?? 0)}`,
          `receipt-blob-check;dur=${duration(receiptDurations["blob-check"] ?? 0)}`,
          `receipt-asset-weight;dur=${duration(receiptDurations["asset-weight"] ?? 0)}`,
          `receipt-fact-drift;dur=${duration(receiptDurations["fact-drift"] ?? 0)}`,
          `receipt-advisories;dur=${duration(receiptDurations["advisories"] ?? 0)}`,
          `total;dur=${duration(responseStartedAt - requestStartedAt)}`,
        ].join(", "),
      )
      return c.json(
        {
          ...toJson(deps.baseUrl, artifact, versions),
          published: version.n,
          // The store is content-addressed, so a single file's blob key IS the
          // sha256 of its stored bytes — callers verify it against their local copy
          // to catch content corrupted on the way in. Bundles store a manifest
          // blob, so there is no single-file hash to report.
          ...(artifact.kind === "file" ? { content_sha256: version.blob_key } : {}),
          ...(storedSlots.length
            ? { data: storedSlots.map((s) => ({ fact: s.slot, bytes: s.size_bytes })) }
            : {}),
          ...(advisories.length ? { advisories } : {}),
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

  // Tokened publish: the same handlePublish, but authorized by a short-lived
  // capability token (minted by the MCP stage_publish tool) instead of a session
  // or bearer — so a hosted-OAuth agent, whose credential is trapped inside the
  // MCP transport, can `curl -F file=@…` a file too large to inline through the
  // publish tool. See lib/publish-token.ts. Verify the token, re-check the bound
  // user's LIVE membership (revocation kills the URL mid-TTL), enforce the target
  // scope, then hand off to handlePublish acting as that user. Distinct segment
  // counts from the routes above, so no registration-order collision.
  const tokenPublish = async (c: Context, shortId?: string) => {
    const secret = deps.encryptionKey
    const token = c.req.param("token") ?? ""
    const claim = secret ? await verifyPublishToken(secret, token, Date.now()) : null
    if (!claim) return fail(c, 403, "invalid or expired publish token")
    // Target scope: a "*" token only creates; a short_id token only revises that
    // exact artifact. Mismatch is a hard refusal, so a leaked token can't be
    // repurposed (create → overwrite, or revise-X → touch-Y).
    if (claim.target === PUBLISH_TARGET_CREATE) {
      if (shortId) return fail(c, 403, "this token can only create a new artifact")
      // CREATE is a workspace-level right, and handlePublish skips workspaceCan for
      // a tokened caller — so re-check the bound user's LIVE workspace publish role
      // here (revocation-safe). REVISE is an artifact-level right that handlePublish
      // re-checks itself (authorizeUserStanding), so it needs nothing extra here.
      const m = await meta.getMembership(claim.orgId, claim.userId)
      if (!m || !roleAllows(m.role, "publish"))
        return fail(c, 403, "invalid or expired publish token")
    } else if (claim.target !== shortId) {
      return fail(c, 403, "this token cannot publish to that artifact")
    }
    const [dir] = await meta.getUsers([claim.userId])
    // The minting agent, when the token names one — its current name, from wherever its
    // kind keeps it (an OAuth client is not an agents-table row).
    const minter = claim.agentId
      ? { id: claim.agentId, name: (await agentName(meta, claim.agentId)) ?? "An agent" }
      : null
    return handlePublish(c, shortId, {
      org: claim.orgId,
      user: { id: claim.userId, name: dir?.name ?? null },
      agent: minter,
    })
  }
  app.post("/v1/artifacts/t/:token", (c) => tokenPublish(c))
  app.post("/v1/artifacts/:shortId/versions/t/:token", (c) =>
    tokenPublish(c, c.req.param("shortId")),
  )

  // ---- Anonymous drafts: publish before signup (the claim flow) ------------
  // POST /v1/drafts takes a file with no credentials and returns a live expiring
  // page on the usercontent domain plus a claim URL; claiming (below) moves the
  // draft into a real workspace.
  //
  // A draft is an ordinary artifact with no owner, held in DRAFTS_ORG_ID with an
  // expires_at (see lib/drafts.ts). It is link-viewable and nothing else — the
  // secret URL is the whole grant — and it serves ONLY on the usercontent host,
  // never the app origin.

  // authz-exempt: anonymous draft mint — anonymous is the point; the draftPublish
  // IP cap + the publish limiter (ip-keyed for an actorless caller) + the
  // ANON_WRITE_ALLOW entry in app.ts bound it.
  app.post("/v1/drafts", async (c) => {
    // Serving needs the usercontent host; the claim URL needs the signing secret.
    if (!deps.subdomainBase || !deps.encryptionKey)
      return fail(c, 501, "anonymous drafts need DERIVE_SUBDOMAIN_BASE and DERIVE_AUTH_SECRET")
    // Idempotent upsert: the holding workspace exists from the first mint onward.
    await meta.setWorkspace(DRAFTS_ORG_ID, "Anonymous drafts")
    const expiresAt = new Date(Date.now() + DRAFT_TTL_MS).toISOString()
    const res = await handlePublish(c, undefined, {
      org: DRAFTS_ORG_ID,
      user: null,
      draft: { expiresAt },
    })
    if (res.status !== 201) return res
    const created = (await res.json()) as { short_id: string }
    const artifact = await meta.getByShortId(created.short_id)
    if (!artifact) return fail(c, 500, "draft vanished after publish")
    // The draft's home: <short_id>.<base>. The short id is fresh and globally
    // unique, so setDomain's insert-only conflict path is effectively unreachable;
    // if it fires anyway, degrade to the raw URL (documented in llms.txt) rather
    // than failing a publish that already succeeded.
    const host = `${artifact.short_id}.${deps.subdomainBase}`.toLowerCase()
    const bound = await meta.setDomain({
      host,
      artifact_id: artifact.id,
      org_id: DRAFTS_ORG_ID,
      kind: "subdomain",
      status: "active",
    })
    const draftUrl = bound
      ? `https://${host}/`
      : `${deps.sandboxOrigin ?? deps.baseUrl}/raw/${artifact.short_id}/v/1/index.html`
    const claimToken = await signClaimToken(deps.encryptionKey, artifact.id, Date.parse(expiresAt))
    // Opportunistic sweep, the OAuth-reaper pattern: each mint reaps earlier
    // expired drafts. This is the ONLY sweep the edge tier gets (its cron has no
    // pg binding); on Workers it rides waitUntil, on Node background() awaits
    // inline — one indexed SELECT when nothing has expired, and the hourly timer
    // there does the real work. The serve path 410s expired drafts regardless.
    await background(sweepExpiredDrafts(meta, search))
    return c.json(
      {
        short_id: artifact.short_id,
        title: artifact.title,
        draft_url: draftUrl,
        claim_url: `${deps.baseUrl}/claim/${claimToken}`,
        expires_at: expiresAt,
      },
      201,
    )
  })

  // The claim page's read: what am I about to claim? Public — the token itself is
  // the proof of standing, exactly like the mint that produced it.
  app.get("/v1/drafts/claim/:token", async (c) => {
    if (!deps.encryptionKey) return fail(c, 501, "drafts are not configured")
    const v = await verifyClaimToken(deps.encryptionKey, c.req.param("token"), Date.now())
    if (!v) return fail(c, 404, "invalid or expired claim link")
    const a = await meta.getArtifactById(v.artifactId)
    if (!a) return fail(c, 410, "this draft expired and was removed")
    if (a.org_id !== DRAFTS_ORG_ID || !a.expires_at)
      return fail(c, 410, "this draft was already claimed")
    if (a.expires_at <= new Date().toISOString()) return fail(c, 410, "this draft expired")
    const bound = (await meta.getArtifactDomains(a.id))[0]
    return c.json({
      short_id: a.short_id,
      title: a.title,
      kind: a.kind,
      expires_at: a.expires_at,
      draft_url: bound ? `https://${bound.host}/` : null,
    })
  })

  // Spend the claim: move the draft into the signed-in caller's active workspace.
  // Requires a principal (not in ANON_WRITE_ALLOW — the global anonymous-write
  // lockdown already refuses this route to anonymous callers before it runs).
  app.post("/v1/drafts/claim", async (c) => {
    if (!deps.encryptionKey) return fail(c, 501, "drafts are not configured")
    const me = await currentUser(c)
    if (!me) return fail(c, 401, "sign in to claim a draft")
    const b = await readJson(c, z.object({ token: z.string().max(2048) }))
    if (b instanceof Response) return b
    const v = await verifyClaimToken(deps.encryptionKey, b.token, Date.now())
    if (!v) return fail(c, 404, "invalid or expired claim link")
    const a = await meta.getArtifactById(v.artifactId)
    if (!a) return fail(c, 410, "this draft expired and was removed")
    // Single-use by state: once claimed the draft has left the holding workspace,
    // so a replayed token finds nothing to spend. Two racing claims on the same
    // secret link can interleave; the loser's move is overwritten — bounded to
    // holders of the same claim URL, which is the capability anyway.
    if (a.org_id !== DRAFTS_ORG_ID || !a.expires_at)
      return fail(c, 410, "this draft was already claimed")
    if (a.expires_at <= new Date().toISOString()) return fail(c, 410, "this draft expired")
    const org = await activeWorkspace(c)
    if (!(await workspaceCan(c, "publish")))
      return fail(c, 403, "you need publish rights in this workspace to claim a draft")
    // Claiming moves the draft INTO this workspace as a real publish — a billing-blocked
    // destination must refuse it exactly like any other publish would.
    const blocked = await billingGate(c, org)
    if (blocked) return blocked
    const url = artifactUrl(deps.baseUrl, a)
    // Order matters: the host must be unbound before the org move (the move path
    // refuses to relocate a domain-bound artifact), and the signpost keeps the
    // shared draft URL alive as a 302 to the artifact's permanent home.
    for (const d of await meta.getArtifactDomains(a.id))
      await meta.updateDomain(d.host, { artifact_id: null, redirect_to: url })
    await meta.moveArtifactOrg(a.id, org)
    await meta.setArtifactExpiry(a.id, null)
    // The claimed artifact lands as the workspace's own default (the team draft),
    // shedding the draft's link-viewable shape — sharing wider stays a human act.
    const settings = await meta.getOrgSettings(org)
    await meta.setAccess(
      a.id,
      settings.defaultWorkspaceAccess,
      settings.defaultListed,
      settings.defaultLinkRole,
      null,
    )
    await meta.setArtifactMember({
      id: newId("am"),
      artifact_id: a.id,
      user_id: me.id,
      role: "owner",
    })
    // moveArtifactOrg re-scopes the FTS row; the dense vector lives outside the DB,
    // so re-embed under the new org (same recipe as the move route). Best-effort.
    if (search) {
      try {
        const ver = await meta.getVersion(a.id, a.current_version)
        if (ver) await indexArtifactVersion(meta, blobs, { ...a, org_id: org }, ver, search)
      } catch (err) {
        log.error("dense re-index after claim failed", { artifact: a.id, err: String(err) })
      }
    }
    return c.json({ short_id: a.short_id, url, org_id: org })
  })

  // Registered BEFORE GET /v1/artifacts/{shortId} below: Hono's router matches
  // routes in REGISTRATION order, not by static-vs-param specificity, so
  // /v1/artifacts/search must come first or it's shadowed by :shortId="search"
  // (caught by a regression test in test/search-rest.test.ts).
  //
  // Common query-param parsing for both search routes below — case_sensitive/in/
  // context/max_matches share the same defaults and bounds as the MCP `search`
  // tool (apps/api/src/mcp.ts), so a query behaves identically whichever surface
  // (remote MCP, this REST route, or the stdio CLI that calls it) issues it.
  const parseSearchParams = (c: Context) => ({
    query: c.req.query("query"),
    re: searchMatcher(c.req.query("query") ?? "", c.req.query("case_sensitive") === "true"),
    where: (c.req.query("in") === "text" ? "text" : "source") as "source" | "text",
    ctxLines: Math.min(Math.max(Number(c.req.query("context")) || 0, 0), 5),
    cap: Math.min(Math.max(Number(c.req.query("max_matches")) || 40, 1), 200),
  })

  // Grep ACROSS a workspace's artifacts — the REST counterpart of the MCP `search`
  // tool's short_id-omitted mode. Visibility mirrors GET /v1/artifacts exactly (same
  // memberKey/publicOnly derivation): a caller sees the same artifacts here as they
  // would in a listing, never more.
  app.get("/v1/artifacts/search", async (c) => {
    const me = await currentUser(c)
    const agent = me ? null : await agentFor(c)
    if (!me && !agent && !isToken(c)) return bail(fail(c, 401, "unauthenticated"))
    const { query, re, where, ctxLines, cap } = parseSearchParams(c)
    if (!query) return fail(c, 400, "`query` is required")

    const memberKey = me?.id ?? agent?.created_by ?? agent?.id ?? null
    const listOrg = await activeWorkspace(c)
    const isOperator = isToken(c)
    const baselineRole = me
      ? ((await membershipOf(c, listOrg, me.id))?.role ?? null)
      : agent && agent.org_id === listOrg
        ? agent.role
        : null
    const publicOnly = !(isOperator || baselineRole !== null)

    // `?format=json` is the UI shape: a ranked hit list with a snippet per artifact instead of the
    // agent-facing ripgrep text report. Two callers, one shape: the ⌘K palette typeahead requests a
    // tiny `limit` (≤~6) so a debounced keystroke reads only a few blobs; the /search results page
    // requests a deeper page (up to 50). Bounded 1..50 either way — a page reads up to `limit` blobs
    // for grep-confirm, acceptable off the hot typeahead path but still capped.
    const isJson = c.req.query("format") === "json"
    const limit = isJson ? Math.min(Math.max(Number(c.req.query("limit")) || 6, 1), 50) : undefined
    // Nomination breadth scales with the requested depth: the palette (limit ~6) stays at the cheap
    // 60-candidate single-chunked visibility resolve; the results page (limit ~30) nominates deeper
    // so the ranked list is fuller. Capped at the workspace default (200) so it can't run away.
    const candidateCap = isJson ? Math.min(Math.max((limit ?? 6) * 4, 60), 200) : undefined

    const { results, note } = await searchWorkspace(
      { blobs, sourceText, meta, search },
      {
        orgId: listOrg,
        viewerId: isOperator ? undefined : (memberKey ?? undefined),
        publicOnly,
        query,
        re,
        where,
        ctxLines,
        cap,
        limit,
        candidateCap,
      },
    )
    if (isJson) {
      c.header("X-Content-Type-Options", "nosniff")
      c.header("Cache-Control", "no-store")
      return c.json({ hits: toSearchHits(results, query), truncated: note !== null })
    }
    c.header("Access-Control-Allow-Origin", "*")
    c.header("X-Content-Type-Options", "nosniff")
    c.header("Content-Type", "text/plain; charset=utf-8")
    return c.body(workspaceSearchReport(query, where, results, note))
  })

  // Grep WITHIN one artifact — the REST counterpart of the MCP `search` tool's
  // short_id-present mode, and what the self-hosted stdio CLI's search calls (the
  // remote MCP server talks to this same meta/blobs store directly instead, but the
  // grep logic itself — lib/search.ts — is the identical shared engine either way).
  // This one is safe registered anywhere relative to :shortId's OTHER routes (its
  // path has an extra /search segment, so it can't collide the way the bare
  // /v1/artifacts/search route above can) but stays next to it for cohesion.
  app.get("/v1/artifacts/:shortId/search", async (c) => {
    const artifact = await requireArtifact(c, "read")
    if (artifact instanceof Response) return artifact
    if (artifact.current_version === 0) return fail(c, 404, "not found")
    if (artifact.removed_at) return fail(c, 410, TOMBSTONE)
    const { query, re, where, ctxLines, cap } = parseSearchParams(c)
    if (!query) return fail(c, 400, "`query` is required")
    const v = c.req.query("v") ? Number(c.req.query("v")) : artifact.current_version
    if (!Number.isInteger(v)) return fail(c, 400, "bad version")
    const version = await meta.getVersion(artifact.id, v)
    if (!version) return fail(c, 404, `no version ${v}`)

    const { groups, total, note } = await searchArtifactVersion(
      { blobs, sourceText },
      version,
      re,
      where,
      ctxLines,
      cap,
    )
    c.header("Access-Control-Allow-Origin", "*")
    c.header("X-Content-Type-Options", "nosniff")
    c.header("Content-Type", "text/plain; charset=utf-8")
    return c.body(searchReport(c.req.param("shortId"), query, where, total, cap, groups, note))
  })

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
      const shortId = c.req.param("shortId")
      // THE DOCUMENT OPEN'S CRITICAL PATH. Measured on the preview, this request is 457ms
      // of a 481ms open — the journey basically IS this handler. It used to open with two
      // strictly serial reads: the artifact, and then the caller's grants on it, which
      // could not start until the first landed because it needs the artifact's id and org.
      // `artifactWithGrants` resolves the artifact inside the grants query, so the pair
      // costs one round trip instead of two. Optional, like `artifactGrants` beneath it:
      // a store without it takes the read-by-read path unchanged.
      const viewer = await currentUser(c)
      // Active-workspace validation is another independent read. Start it beside the
      // artifact query so workspace-scoped authorization does not put a new serial trip
      // on the document-open critical path. activeWorkspace memoizes this promise, so
      // actorFor below consumes the same result rather than starting it again.
      const activeOrg = viewer ? activeWorkspace(c) : Promise.resolve<string | null>(null)
      const combined =
        viewer && meta.artifactWithGrants
          ? await meta.artifactWithGrants(shortId, viewer.id)
          : undefined
      // `combined` is undefined when the fast path did not run at all (anonymous caller,
      // or a store without it) and null when it ran and found nothing — only the first
      // needs the read-by-read fallback.
      const artifact =
        combined !== undefined ? combined?.artifact : await meta.getByShortId(shortId)
      // 404 BEFORE resolving an actor. This used to run actorFor against a placeholder
      // artifact first, which for a signed-in caller meant a full artifactGrants round
      // trip (~80ms) against an empty id on every miss — paid, then thrown away one line
      // later. Nothing about the response differs: a miss is a bare 404 either way, so
      // an anonymous probe still learns nothing.
      if (!artifact) return bail(fail(c, 404, "not found"))
      const actor = await actorFor(
        c,
        artifact,
        combined && viewer
          ? {
              userId: viewer.id,
              orgRole: combined.orgRole,
              artifactRoles: combined.artifactRoles,
              portableArtifactRoles: combined.portableArtifactRoles,
            }
          : undefined,
      )
      // Workbench actions are scoped to the active workspace. A membership in a
      // different workspace must not enable controls backed by the active workspace.
      const isWorkspaceMember = !!viewer && actor.orgRole != null
      if (!can(actor, "read", artifact.workspace_access, artifact.link_role)) {
        // A workspace mismatch is recoverable without weakening the boundary. Tell
        // a signed-in member where to switch only when their full standing would
        // actually read the artifact there. The response carries no artifact data;
        // strangers and members without artifact access keep the indistinguishable
        // 404 below.
        const resolvedActiveOrg = await activeOrg
        const destinationSeat =
          viewer && resolvedActiveOrg !== artifact.org_id
            ? await membershipOf(c, artifact.org_id, viewer.id)
            : null
        const readableInDestination =
          viewer && destinationSeat
            ? combined
              ? can(
                  {
                    kind: "user",
                    userId: viewer.id,
                    artifactRole: maxRole(null, ...combined.artifactRoles),
                    orgRole: combined.orgRole,
                  },
                  "read",
                  artifact.workspace_access,
                  "none",
                )
              : await authorizeUserStanding(viewer.id, "read", artifact)
            : false
        if (viewer && readableInDestination) {
          const workspace = await meta.getWorkspace(artifact.org_id)
          if (workspace)
            return bail(
              fail(c, 409, "Switch workspaces to view this artifact.", {
                code: "workspace_mismatch",
                workspace: {
                  id: workspace.id,
                  name: workspace.name,
                  personal: workspace.id === `ws_p_${viewer.id}`,
                },
              }),
            )
        }
        // A locked artifact isn't hidden, it's lockable: tell the client to prompt for
        // the password (401) rather than claim it doesn't exist (404). A lock only ever
        // sits on a world link, so a stored hash means the world-link path is gated.
        return bail(
          artifact.password_hash ? fail(c, 401, "password required") : fail(c, 404, "not found"),
        )
      }
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
          is_workspace_member: isWorkspaceMember,
          tags: [],
          favorite: false,
          collections: [],
          collection_access: [],
          removed: true,
        })
      // The detail response's whole artifact-scoped context — versions, tags, the
      // collections it sits in, the open-thread count, the viewer's
      // favorite, and the workspace's settings
      // — in ONE store call. These were eight sequential round trips (~80ms each on the
      // edge, see edge-pg.ts) all keyed on this one artifact or its org.
      const detail = await meta.artifactDetail({
        artifactId: artifact.id,
        orgId: artifact.org_id,
        viewerId: actor.kind === "user" ? (actor.userId ?? null) : null,
      })
      const allVersions = detail.versions
      // Private history requires a workspace seat or collaborator grant. A world
      // link remains current-version-only even when its holder is signed in.
      const versions =
        !hasArtifactStanding(actor, artifact.workspace_access) && !artifact.public_history
          ? allVersions.filter((v) => v.n === artifact.current_version)
          : allVersions
      const me = actor.kind === "user" ? actor.userId : null
      const tags = detail.tags
      const favorite = detail.favorite
      const collections = detail.collectionIds
      const myRole = effectiveRole(actor, artifact.workspace_access, artifact.link_role)
      // The share dialog's disclosure rows: which collections' sharing REACHES this
      // artifact (a workspace-open collection propagates every seat; an invite-only
      // one its members — see collectionRolesForArtifact). The artifact's own access
      // fields never reflect that grant, so the detail response must carry it or the
      // dialog lies ("Invited · 1 person" on a doc the whole workspace can open).
      // Two independent gates shape the list:
      //   VISIBLE — collections the caller has a role on (their explicit share, a
      //     seat on a workspace-open one, created_by, or the operator token), plus
      //     everything for the artifact's own managers. Manager standing is computed
      //     WITHOUT the world link (linkRole "none") — a stranger holding an editor
      //     URL must not unlock other people's private collections' titles/rosters,
      //     the same class of caller the members-roster route 404s.
      //   GRANTING — of those, only collections that actually ADD reach: any
      //     workspace-open one; an invite-only one only when someone besides the
      //     caller enters through it (another member row, or a creator who isn't
      //     them). This is the response's contract — consumers render it verbatim.
      const standing = effectiveRole(actor, artifact.workspace_access, "none")
      const canManageArtifact = standing === "owner" || standing === "editor"
      let collectionAccess: {
        id: string
        title: string
        workspace_access: WorkspaceAccess
        my_role: Role | null
        member_count: number
        created_by: string
        owner_name: string | null
      }[] = []
      // Anonymous link readers can never see a row (no role, no standing) — skip the
      // lookups entirely on that hot path.
      if (collections.length > 0 && (me !== null || isToken(c) || canManageArtifact)) {
        const workspaceActive = isToken(c) || (await activeWorkspace(c)) === artifact.org_id
        const roles = me
          ? workspaceActive
            ? meta.collectionRolesForUser(collections, me)
            : meta
                .collectionRolesForUser(collections, me, { includeWorkspaceSeats: false })
                .then((byId) =>
                  Object.fromEntries(Object.entries(byId).filter(([, role]) => role !== "owner")),
                )
          : Promise.resolve<Record<string, Role>>({})
        const [colRecords, rolesById] = await Promise.all([meta.getCollections(collections), roles])
        // Fold in creator ownership only in the collection's active workspace. On a
        // portable artifact open, the role map above likewise contains only explicit
        // non-owner collection shares — never a foreign workspace seat.
        const roleOf = (col: (typeof colRecords)[number]): Role | null =>
          isToken(c)
            ? "owner"
            : workspaceActive && col.created_by === me
              ? "owner"
              : (rolesById[col.id] ?? null)
        const visible = colRecords
          .map((col) => ({ col, role: roleOf(col) }))
          .filter(({ role }) => role !== null || (workspaceActive && canManageArtifact))
        const [memberCounts, creatorNames] = await Promise.all([
          meta.collectionMemberCounts(visible.map(({ col }) => col.id)),
          resolveUserBylines(meta, [...new Set(visible.map(({ col }) => col.created_by))]),
        ])
        collectionAccess = visible
          .filter(
            ({ col }) =>
              col.workspace_access === "member" ||
              col.created_by !== me ||
              (memberCounts[col.id] ?? 0) >= 2,
          )
          .map(({ col, role }) => ({
            id: col.id,
            title: col.title,
            workspace_access: col.workspace_access,
            my_role: role,
            member_count: memberCounts[col.id] ?? 0,
            created_by: col.created_by,
            owner_name: creatorNames[col.created_by]?.name ?? null,
          }))
      }
      // A markdown bundle (a skill — entry SKILL.md — or a docs folder) gets a `bundle`
      // block: the entry + file tree (so the client can render the doc and navigate
      // siblings) plus skill identity when it is one. One manifest read, on the detail
      // page only — the list view stays blob-free (no N+1). HTML "site" bundles navigate
      // via their own links, so they get no block.
      let bundle: BundleDoc | undefined
      const current = versions.find((v) => v.n === artifact.current_version)
      const cur = artifact.kind === "bundle" ? current : undefined
      if (cur) {
        const manifestBytes = await blobs.get(cur.blob_key)
        if (manifestBytes) {
          const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as BundleManifest
          // A paper (entry main.tex) gets the same block: the viewer lists its sources,
          // figures and .bib beside the rendered page.
          if (isMarkdownBundle(manifest) || isLatexBundle(manifest))
            bundle = bundleDoc(manifest, await sourceText(cur))
        }
      }
      // Linked bundles stay ordinary HTML artifacts. Their one authored fact is the
      // source of truth; this detail-only block is native chrome over that fact, with
      // every member resolved through the same read gate as opening it directly.
      let linkedBundle:
        | (LinkedBundleManifest & {
            members: Array<
              LinkedBundleManifest["members"][number] & {
                available: boolean
                url?: string
                title?: string | null
                content_type?: string | null
                current_version?: number
                updated_at?: string | null
                open_comment_count?: number
              }
            >
          })
        | undefined
      let workflowPreview: WorkflowPreview | undefined
      if (current?.content_type === LINKED_BUNDLE_CONTENT_TYPE) {
        // One version-data read carries both authored facts. The native graph and
        // native Preview must come from the same immutable version without adding a
        // second round trip to this hot detail route.
        const dataRows = await meta.getVersionData(artifact.id, current.n)
        const facts = parseLinkedWorkflowFacts(dataRows)
        const manifest = facts.manifest
        if (manifest) {
          workflowPreview = facts.preview
          try {
            const resolved = await resolveArtifacts(
              c,
              manifest.members.map((member) => member.ref),
            )
            const byRef = new Map(resolved.map((member) => [member.short_id, member]))
            const [readableRows, commentSignals] = await Promise.all([
              Promise.all(
                resolved.map(
                  async (member) => [member.short_id, await authorize(c, "read", member)] as const,
                ),
              ),
              meta.commentSignals(
                actor.kind === "user" ? resolved.map((member) => member.id) : [],
                actor.kind === "user" ? (actor.userId ?? null) : null,
              ),
            ])
            const readable = new Map(readableRows)
            linkedBundle = {
              ...manifest,
              members: manifest.members.map((member) => {
                const target = byRef.get(member.ref)
                if (!target || target.removed_at || !readable.get(member.ref))
                  return { ...member, available: false }
                return {
                  ...member,
                  available: true,
                  url: artifactUrl(deps.baseUrl, target),
                  title: target.title,
                  content_type: target.current_content_type,
                  current_version: target.current_version,
                  updated_at: target.updated_at,
                  ...(actor.kind === "user"
                    ? { open_comment_count: commentSignals[target.id]?.open_threads ?? 0 }
                    : {}),
                }
              }),
            }
          } catch {
            // Stored authored facts are validated JSON. If an old/corrupt row slips
            // through, omit the enhancement; the artifact itself remains readable.
          }
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
      // Resolve the Derive user(s) behind a publish-by-hand (author_id on the artifact + each
      // version) to their live name/handle, so a byline frozen with an agent-client name self-
      // heals on read. One batched query alongside the gh_id resolve above — no N+1.
      // No round trip: artifactDetail's `byline` arm already returned the live rows for
      // every author_id on this artifact and its versions, in the same statement. This
      // used to be its own resolveUserBylines call, sequential after resolveHandles —
      // ~80ms on the edge, on the request that gates the document's rendered bytes.
      const bylineByUserId = bylinesFrom(detail.bylines)
      // Remix provenance for the derived-from banner: resolve the source to its public
      // identity. Detail-only (the list would N+1), and only for derived rows.
      const derivedFrom = artifact.derived_from
        ? await meta.getArtifactById(artifact.derived_from)
        : null
      const base = toJson(deps.baseUrl, artifact, versions)
      const rawTokenIssuedAt = bucketedNow(RAW_TOKEN_WINDOW_MS)
      // `versions` stays at revision granularity (machines/agents); `sessions` is
      // the time-grouped view the UI shows by default. `my_role` tells the client
      // which actions to surface.
      return c.json({
        ...base,
        // Resolved author profile for the current author (null when there's none, or the
        // committer never signed in with GitHub — then `handle` is null but name/login/avatar
        // still describe the GitHub identity). The frontend prefers this over the raw fields.
        author: authorProfile(artifact, handleByGhId, bylineByUserId),
        versions: base.versions.map((v, i) => {
          const authorId = versions[i]?.author_id
          const byUser = authorId ? bylineByUserId[authorId] : undefined
          return {
            ...v,
            // The version's frozen byline heals to its author's live name (an old CLI/MCP
            // publish stops reading as "Derive CLI"/"Claude"); sync versions keep the gh handle.
            author: byUser?.name ?? v.author,
            handle:
              byUser?.handle ?? (v.author_gh_id ? (handleByGhId[v.author_gh_id] ?? null) : null),
          }
        }),
        sessions: groupSessions(versions, versionWindowMs),
        my_role: myRole,
        is_workspace_member: isWorkspaceMember,
        // Show the Made-with-Derive mark on this artifact's public surfaces? False
        // only for white-label workspaces that are also entitled to it (beta, or an
        // active subscription); the viewer reads this single boolean so workspace
        // settings and billing state never travel to anonymous clients. The settings
        // ride in from artifactDetail's batch, so the common case (white-label off)
        // costs no round trip at all here.
        badge: !(await effectiveWhiteLabel(artifact.org_id, detail.settings)),
        // The owner may expose history to readers who lack standing on the artifact.
        public_history: !!artifact.public_history,
        // Open-thread count for the public viewer's sign-in-to-comment pill. Anon
        // never sees comment bodies (collaboration, not content — see comments.ts),
        // so the count is the one bit that crosses; it crosses only where the pill
        // can fire (a link that grants commenting) so view-only links leak nothing.
        // Gate on the RAW link_role: anon's effective role is always clamped to
        // viewer — the whole point of the pill is what signing in would unlock.
        ...(actor.kind === "anon" &&
        (artifact.link_role === "commenter" || artifact.link_role === "editor")
          ? { open_comment_count: detail.openThreads }
          : {}),
        // The artifact's current workspace — the move dialog needs this to exclude
        // it from the destination picker.
        org_id: artifact.org_id,
        ...(artifact.derived_from
          ? {
              derived_from:
                derivedFrom && !derivedFrom.removed_at
                  ? { short_id: derivedFrom.short_id, title: derivedFrom.title }
                  : null,
            }
          : {}),
        tags,
        favorite,
        collections,
        collection_access: collectionAccess,
        // Present for a markdown bundle (skill or docs folder): { isSkill, name,
        // description, entry, files } — the client renders the file tree + skill chrome.
        ...(bundle ? { bundle } : {}),
        ...(linkedBundle ? { linked_bundle: linkedBundle } : {}),
        ...(workflowPreview ? { workflow_preview: workflowPreview } : {}),
        // A taken-down artifact keeps its record but serves no content (410); the
        // UI shows a tombstone instead of the iframe.
        removed: !!artifact.removed_at,
        // The content iframe is sandboxed with no `allow-same-origin` (opaque origin —
        // it must not be able to touch derive.to cookies/storage), which means it also has
        // no origin of its own to send OUR session cookie back on, and Chrome refuses to
        // attach cookies to requests from an opaque origin at all (even same-site) — every
        // sub-resource (image, css, ...) in a non-public bundle 404s there. `read` access
        // was just proven above, so mint a short-lived capability the SPA embeds in the raw
        // URL's path (raw.ts's `t/:token` route + RAW_TOKEN_MAX_AGE_MS) — path, not query,
        // so relative asset references inherit it with zero HTML rewriting.
        // Bucketed `iat` (not Date.now()): the token is byte-identical for every mint
        // inside a RAW_TOKEN_WINDOW_MS window, so the viewer's iframe URL is stable and
        // its cached bytes are actually reachable on a re-open. Freshly stamping it made
        // a different URL every fetch, which silently defeated the cache — measured, an
        // open whose URL matched served in 13ms from cache; the next one re-downloaded
        // 15KB. Validity is unchanged (verifyState still enforces the same max age).
        raw_token: signState(
          {
            rid: artifact.id,
            history:
              artifact.public_history || hasArtifactStanding(actor, artifact.workspace_access),
          },
          deps.encryptionKey ?? "",
          rawTokenIssuedAt,
        ),
        // The detail record can outlive the capability in the browser query cache.
        // Make the lifetime explicit so the viewer never pins an expired token while
        // React Query refreshes the record in the background.
        raw_token_expires_at: new Date(rawTokenIssuedAt + RAW_TOKEN_MAX_AGE_MS).toISOString(),
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
                workspace_access: z
                  .enum(["none", "member"])
                  .describe("New workspace access: member = seats reach it; none = they don't."),
                link_role: z
                  .enum(["none", "viewer", "commenter", "editor"])
                  .describe("New world-link role; none = no link."),
                listed: z
                  .enum(["none", "workspace", "public"])
                  .describe("New discovery listing: nowhere, the workspace, or public."),
                locked: z.boolean().describe("true when the world link is now password-locked."),
                public_history: z
                  .boolean()
                  .describe("Whether the anonymous public page shows version history."),
              }),
            },
          },
        },
      },
    }),
    async (c) => {
      const artifact = await resolveArtifact(c, c.req.param("shortId"))
      if (!artifact) return bail(fail(c, 404, "not found"))
      if (!(await authorizeStanding(c, "share", artifact))) return bail(fail(c, 403, "forbidden"))
      const b = await readJson(
        c,
        z.object({
          workspaceAccess: z.enum(["none", "member"]).optional(),
          linkRole: z.enum(["none", "viewer", "commenter", "editor"]).optional(),
          listed: z.enum(["none", "workspace", "public"]).optional(),
          password: z.string().optional(),
          // Owner opt-in: the anonymous public page shows version history.
          // Omitted preserves; rides this route because it's a disclosure
          // control like the triple, applied by the same dialog.
          publicHistory: z.boolean().optional(),
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
        if (b.password) passwordHash = await hashPassword(b.password)
        else if (b.password === undefined) passwordHash = artifact.password_hash ?? null
      }
      // Legacy `visibility=password` means "link + lock": it must carry a password.
      if (b.visibility === "password" && !passwordHash)
        return bail(fail(c, 400, "a password is required for password visibility"))
      await meta.setAccess(artifact.id, workspaceAccess, listed, linkRole, passwordHash)
      const publicHistory = b.publicHistory ?? !!artifact.public_history
      if (b.publicHistory !== undefined)
        await meta.setPublicHistory(artifact.id, b.publicHistory ? 1 : 0)
      return c.json({
        workspace_access: workspaceAccess,
        link_role: linkRole,
        listed,
        locked: !!passwordHash,
        public_history: publicHistory,
      })
    },
  )

  // Lock / unlock an artifact. Any editor (publish rights) can flip it. While
  // locked, publishes are rejected (handlePublish) — the lock is a freeze: suggest
  // the change as a comment, or unlock to publish.
  app.openapi(
    createRoute({
      method: "patch",
      path: "/v1/artifacts/{shortId}/locked",
      tags: ["Artifacts"],
      summary: "Lock or unlock an artifact (locked ⇒ nothing publishes until unlocked).",
      request: { params: z.object({ shortId: z.string() }) },
      responses: {
        200: {
          description: "The new locked state.",
          content: { "application/json": { schema: z.object({ locked: z.boolean() }) } },
        },
      },
    }),
    async (c) => {
      const artifact = await resolveArtifact(c, c.req.param("shortId"))
      if (!artifact) return bail(fail(c, 404, "not found"))
      if (!(await authorizeStanding(c, "publish", artifact))) return bail(fail(c, 403, "forbidden"))
      const b = await readJson(c, z.object({ locked: z.boolean() }))
      if (b instanceof Response) return bail(b)
      await meta.setLocked(artifact.id, b.locked ? 1 : 0)
      return c.json({ locked: b.locked })
    },
  )

  // Archive changes discovery only; direct reads and related records remain intact.
  for (const archived of [true, false] as const) {
    app.openapi(
      createRoute({
        method: archived ? "put" : "delete",
        path: "/v1/artifacts/{shortId}/archive",
        tags: ["Artifacts"],
        summary: archived ? "Archive an artifact (editors)." : "Restore an archived artifact.",
        request: { params: z.object({ shortId: z.string() }) },
        responses: {
          200: {
            description: archived ? "Archived." : "Restored to the library.",
            content: { "application/json": { schema: z.object({ archived: z.boolean() }) } },
          },
        },
      }),
      async (c) => {
        const artifact = await requireArtifact(c, "publish")
        if (artifact instanceof Response) return bail(artifact)
        if (archived && artifact.removed_at)
          return bail(fail(c, 409, "removed artifacts cannot be archived"))
        await meta.setArtifactArchived(artifact.id, archived ? new Date().toISOString() : null)
        return c.json({ archived })
      },
    )
  }

  // Bulk archive and restore preserve the per-artifact authorization contract.
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/bulk/archive",
      tags: ["Artifacts"],
      summary: "Archive or restore many artifacts (editor-gated per artifact).",
      responses: {
        200: {
          description: "How many were archived or restored / skipped / failed.",
          content: { "application/json": { schema: BulkSummarySchema } },
        },
      },
    }),
    async (c) => {
      const body = await readJson(
        c,
        z.object({
          shortIds: z.array(z.string()).min(1).max(BULK_MAX),
          archived: z.boolean(),
        }),
      )
      if (body instanceof Response) return bail(body)
      const timestamp = body.archived ? new Date().toISOString() : null
      const summary = await bulkArtifactOp(
        body.shortIds,
        (ids) => resolveArtifacts(c, ids),
        async (a) => {
          if (body.archived && a.removed_at) return false
          return authorize(c, "publish", a)
        },
        (a) => meta.setArtifactArchived(a.id, timestamp),
      )
      return c.json(summary)
    },
  )

  // Rename. A title is metadata, not content — but renaming used to mean
  // republishing the whole document through the source editor, which minted a
  // version whose diff was empty and pushed a "new version" cue at everyone reading
  // it. This touches the row and the search index, nothing else, so history stays
  // about content. The url name follows the title (same reasoning as publish's
  // rename path) and every link already shared keeps working: a ref resolves on its
  // trailing short id.
  app.openapi(
    createRoute({
      method: "patch",
      path: "/v1/artifacts/{shortId}",
      tags: ["Artifacts"],
      summary: "Rename an artifact (metadata only — no new version).",
      request: { params: z.object({ shortId: z.string() }) },
      responses: {
        200: {
          description: "The new title and url name.",
          content: {
            "application/json": {
              schema: z.object({ title: z.string(), slug: z.string().nullable() }),
            },
          },
        },
      },
    }),
    async (c) => {
      const artifact = await resolveArtifact(c, c.req.param("shortId"))
      if (!artifact) return bail(fail(c, 404, "not found"))
      // Publish rights, the same bar as editing the words — a rename is an edit
      // everyone can see. A LOCKED artifact is still renamable: the lock is about
      // content going through review, and a title carries none.
      if (!(await authorizeStanding(c, "publish", artifact))) return bail(fail(c, 403, "forbidden"))
      const b = await readJson(c, z.object({ title: z.string().min(1).max(200) }))
      if (b instanceof Response) return bail(b)
      const title = b.title.trim()
      if (!title) return bail(fail(c, 400, "title is empty"))
      const slug = slugify(title) || null
      await meta.setArtifactTitle(artifact.id, title, slug)
      // The index carries the title beside the text, so skipping it would leave the
      // old name findable and the new one not. Best-effort, like every other
      // re-index path: a search hiccup must not fail the rename that committed.
      try {
        const v = await meta.getVersion(artifact.id, artifact.current_version)
        if (v) await indexArtifactVersion(meta, blobs, { ...artifact, title }, v, search)
      } catch (err) {
        log.error("re-index after rename failed", { artifact: artifact.id, err: String(err) })
      }
      return c.json({ title, slug })
    },
  )

  // Permanently delete an artifact and all its dependents (versions, comments,
  // memberships, etc.). Owner-only: gated by the `manage` action.
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
      const artifact = await requireArtifact(c, "manage", { split: true })
      if (artifact instanceof Response) return bail(artifact)
      // Drops the row + FTS entry (in deleteArtifact) AND the dense vector (best-effort) — one
      // helper so a hard-delete path can't clean one arm and forget the other.
      await deleteArtifactAndUnindex(meta, search, artifact.id, artifact.org_id)
      return c.body(null, 204)
    },
  )

  // Bulk delete — the library multi-select bar. Owner-only per artifact (the same `manage`
  // gate as the single delete); anything you don't own comes back as `skipped` rather than
  // failing the batch, so a mixed selection deletes what's yours and leaves the rest.
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/bulk/delete",
      tags: ["Artifacts"],
      summary: "Permanently delete many artifacts (owner-only per artifact).",
      responses: {
        200: {
          description: "How many were deleted / skipped / failed.",
          content: { "application/json": { schema: BulkSummarySchema } },
        },
      },
    }),
    async (c) => {
      const body = await readJson(
        c,
        z.object({ shortIds: z.array(z.string()).min(1).max(BULK_MAX) }),
      )
      if (body instanceof Response) return bail(body)
      const summary = await bulkArtifactOp(
        body.shortIds,
        (ids) => resolveArtifacts(c, ids),
        (a) => authorize(c, "manage", a),
        (a) => deleteArtifactAndUnindex(meta, search, a.id, a.org_id),
      )
      return c.json(summary)
    },
  )

  // Move to a different workspace you belong to. Owner-only (the `manage` gate —
  // same as delete). A linked bundle is one user-visible artifact even though its
  // members are independently stored artifacts, so moving its shell recursively
  // carries every member that still lives beside it. Cross-workspace refs remain
  // refs: they were already intentionally external to the bundle's workspace.
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
      const artifact = await requireArtifact(c, "manage", { split: true })
      if (artifact instanceof Response) return bail(artifact)
      const b = await readJson(c, z.object({ targetOrgId: z.string().min(1) }))
      if (b instanceof Response) return bail(b)
      if (b.targetOrgId === artifact.org_id) return bail(fail(c, 400, "already in that workspace"))
      // Resolve the human behind either a browser session or an owner-scoped API
      // capability. `actingUser` would return the OAuth client id for the latter,
      // which is not the id stored in workspace memberships.
      const me = await actingHuman(c)
      if (!me) return bail(fail(c, 401, "unauthenticated"))
      if (!(await meta.getMembership(b.targetOrgId, me.id)))
        return bail(fail(c, 403, "you're not a member of that workspace"))

      // DFS post-order gives us leaves before their bundle shells. Mark a node as
      // seen before following its refs so authored cycles cannot recurse forever;
      // the same set also collapses members linked from more than one parent.
      const sourceOrgId = artifact.org_id
      const seen = new Set<string>()
      const moving: ArtifactRecord[] = []
      const collect = async (candidate: ArtifactRecord): Promise<void> => {
        if (seen.has(candidate.id)) return
        seen.add(candidate.id)
        if (candidate.current_content_type === LINKED_BUNDLE_CONTENT_TYPE) {
          const facts = parseLinkedWorkflowFacts(
            await meta.getVersionData(candidate.id, candidate.current_version),
          )
          if (facts.manifest) {
            const members = await meta.getByShortIds(
              facts.manifest.members.map((member) => member.ref),
            )
            for (const member of members)
              if (!member.removed_at && member.org_id === sourceOrgId) await collect(member)
          }
        }
        moving.push(candidate)
      }
      await collect(artifact)

      // Preflight the complete graph before changing any row. Moving a shell but
      // refusing one of its children recreates the exact orphaning this cascade is
      // designed to prevent.
      for (const candidate of moving) {
        if (!(await authorize(c, "manage", candidate)))
          return bail(fail(c, 403, `you can't move linked artifact ${candidate.short_id}`))
        // A bound custom domain routes by artifact_id; moving orgs out from under it
        // would silently break live traffic, so refuse the whole graph.
        if ((await meta.getArtifactDomains(candidate.id)).length > 0)
          return bail(
            fail(
              c,
              409,
              `remove the custom domain before moving linked artifact ${candidate.short_id}`,
            ),
          )
      }

      for (const candidate of moving) await meta.moveArtifactOrg(candidate.id, b.targetOrgId)
      // moveArtifactOrg re-scopes the FTS row in the DB; the dense vector lives outside it, so
      // re-embed under the new org here — otherwise it keeps its old org_id metadata and vanishes
      // from the new workspace's semantic search until the next publish. Best-effort.
      if (search) {
        for (const candidate of moving) {
          try {
            const v = await meta.getVersion(candidate.id, candidate.current_version)
            if (v)
              await indexArtifactVersion(
                meta,
                blobs,
                { ...candidate, org_id: b.targetOrgId },
                v,
                search,
              )
          } catch (err) {
            log.error("dense re-index after move failed", {
              artifact: candidate.id,
              err: String(err),
            })
          }
        }
      }
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
      if (!(await verifyPassword(b.password, artifact.password_hash)))
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
          content: {
            "application/json": {
              schema: Artifact.extend({
                published: z.number().describe("The new version number created by the restore."),
              }),
            },
          },
        },
      },
    }),
    async (c) => {
      const artifact = await requireArtifact(c, "publish", { split: true })
      if (artifact instanceof Response) return bail(artifact)
      // A restore is a publish (it writes a new version), so it's gated the same way:
      // a billing-blocked workspace can't add a version by restoring one either.
      const blocked = await billingGate(c, artifact.org_id)
      if (blocked) return bail(blocked)
      const body = await readJson(c, z.object({ version: z.number().int("version required") }))
      if (body instanceof Response) return bail(body)
      const src = await meta.getVersion(artifact.id, body.version)
      if (!src) return bail(fail(c, 404, `no version ${body.version}`))
      const me = await currentUser(c)
      // An agent restoring on someone's behalf is the version's actor, like any publish.
      const agent = await agentFor(c)
      const version = await meta.addVersion(artifact.id, {
        id: newId("v"),
        blob_key: src.blob_key,
        content_type: src.content_type,
        // Same blob as the restored version — carry its size so the storage meter
        // stays consistent (and dedup'd, since it reuses the same blob_key).
        size_bytes: src.size_bytes,
        author: me ? (me.name ?? me.username ?? me.email) : "anonymous",
        author_id: me?.id ?? null,
        agent_id: agent?.id ?? null,
        agent_name: agent?.name ?? null,
        // A restore is a web-surface action, whatever surface made the original.
        source: "web",
        message: `Restored v${src.n}`,
        name: null,
      })
      // A restore is a version bump too: same webhook + realtime + re-anchor as a publish,
      // but never a new artifact, so no follower fan-out and no thread resolves.
      await afterPublish(
        {
          meta,
          blobs,
          bus,
          notify,
          notifyRender,
          background,
          search,
          summarize,
          baseUrl: deps.baseUrl,
        },
        artifact,
        version,
        {
          isNew: false,
          onBehalf: null,
          actorId: (await actingUser(c))?.id ?? null,
          // The restored version's dynamic data comes back with it: v7 restored from v3
          // starts from the numbers v3 ended with, not from whatever v6 had.
          dynamicSeedFrom: src.n,
        },
      )
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

  // Use an artifact as a template: copy its current version into the caller's own
  // space. The copy re-points at the source version's stored blob (content-addressed
  // and org-agnostic, so no bytes move — the `restore` recipe, one createArtifact
  // earlier) and records lineage in `derived_from`. Signed-in only: the copy lands
  // in the caller's active workspace at the workspace's own access defaults. The
  // viewer defers a signed-out clicker through login (`?use=1`) rather than minting
  // anything pre-auth — an anonymous holder couldn't edit a copy, so it would add
  // nothing over the source page they're already reading.
  // Anyone who can READ the source can use it — the same standing that lets them
  // select-all-copy the rendered page; `requireArtifact(read)` folds in the world
  // link, membership, and the password unlock cookie.
  //
  // Embedded assets are NOT copied: /blob/:hash is org-blind with the (globally
  // unique, hash-keyed) asset row as allowlist, so images keep serving from the
  // copy. Same accepted semantics as the draft-claim move.
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/artifacts/{shortId}/use",
      tags: ["Artifacts"],
      summary: "Copy this artifact into your workspace (use it as a template).",
      request: { params: z.object({ shortId: z.string() }) },
      responses: {
        201: {
          description: "The new copy's identity and workspace home.",
          content: {
            "application/json": {
              schema: z.object({
                short_id: z.string(),
                title: z.string().nullable(),
                url: z.string().describe("The copy's permanent URL in your workspace."),
                org_id: z.string(),
              }),
            },
          },
        },
      },
    }),
    async (c) => {
      const over = await limited(c, publishLimiter)
      if (over) return bail(over)
      const src = await requireArtifact(c, "read")
      if (src instanceof Response) return bail(src)
      if (src.removed_at) return bail(fail(c, 410, "this artifact was removed"))
      // A draft is itself an unclaimed copy mid-flight; templating one would let the
      // claim funnel fork indefinitely. Claim it first.
      if (src.expires_at) return bail(fail(c, 403, "claim this draft before using it"))
      const srcVersion = await meta.getVersion(src.id, src.current_version)
      if (!srcVersion) return bail(fail(c, 404, "nothing published yet"))
      const me = await currentUser(c)
      // The global anonymous-write gate already refused anonymous callers at the
      // door; this 401 keeps the route safe on its own terms regardless.
      if (!me) return bail(fail(c, 401, "sign in to use this artifact"))
      if (!(await workspaceCan(c, "publish")))
        return bail(fail(c, 403, "you need publish rights in this workspace"))
      const org = await activeWorkspace(c)
      const blocked = await billingGate(c, org)
      if (blocked) return bail(blocked)
      // The copy meters real bytes against the destination (dedup'd blob or not).
      if (await overStorage(org, srcVersion.size_bytes))
        return bail(fail(c, 413, blockCopy.storage.message, { code: blockCopy.storage.code }))
      const settings = await meta.getOrgSettings(org)
      const copy = await meta.createArtifact({
        id: newId("a"),
        short_id: newShortId(),
        org_id: org,
        slug: src.slug,
        title: src.title,
        // The workspace's own default access (the team draft, unless configured wider) —
        // NOT the source's: a public template must not make your copy public.
        workspace_access: settings.defaultWorkspaceAccess,
        link_role: settings.defaultLinkRole,
        listed: settings.defaultListed,
        kind: src.kind,
        spa: src.spa,
        derived_from: src.id,
      })
      const v = await meta.addVersion(copy.id, {
        id: newId("v"),
        blob_key: srcVersion.blob_key,
        content_type: srcVersion.content_type,
        size_bytes: srcVersion.size_bytes,
        author: me.name ?? me.username ?? me.email,
        author_id: me.id,
        source: "web",
        message: `Derived from ${src.short_id}`,
        name: null,
      })
      await meta.setArtifactMember({
        id: newId("am"),
        artifact_id: copy.id,
        user_id: me.id,
        role: "owner",
      })
      await afterPublish(
        {
          meta,
          blobs,
          bus,
          notify,
          notifyRender,
          background,
          search,
          summarize,
          baseUrl: deps.baseUrl,
        },
        copy,
        v,
        { isNew: true, onBehalf: me.id, actorId: me.id },
      )
      return c.json(
        {
          short_id: copy.short_id,
          title: copy.title,
          url: artifactUrl(deps.baseUrl, copy),
          org_id: org,
        },
        201,
      )
    },
  )

  // Resolve only the handles already present in this artifact's current source for
  // the sandboxed reader. Unlike the people directory, this is safe for a
  // public-link reader: it reveals no roster and no new handle oracle, only which
  // visible document tokens are real collaborators eligible for a mention.
  app.get("/v1/artifacts/:shortId/mentions", async (c) => {
    const artifact = await requireArtifact(c, "read")
    if (artifact instanceof Response) return artifact
    if (artifact.current_version === 0) return fail(c, 404, "not found")
    if (artifact.removed_at) return fail(c, 410, TOMBSTONE)
    const version = await meta.getVersion(artifact.id, artifact.current_version)
    if (!version) return fail(c, 404, "version not found")
    if (
      version.content_type !== "text/markdown" &&
      !isHtmlLike(version.content_type) &&
      !isLatexLike(version.content_type)
    )
      return c.json({ handles: [] })
    const source = await sourceText(version)
    if (source === null) return fail(c, 500, "blob missing")
    const targets = await resolveContentMentionTargets(
      meta,
      artifact,
      contentMentionHandles(source, version.content_type),
      null,
    )
    return c.json({ handles: targets.map((target) => target.handle) })
  })

  // Source read-back for machines: returns an artifact's text content for any
  // version, as plain text (?v=N selects a version; defaults to current).
  //
  // ?format=markdown|text renders instead of returning raw source (default: raw,
  // for existing byte-exact consumers). ?outline=1 returns a JSON heading/page
  // outline instead of content. ?section=<slug|page|page#slug> returns just that
  // part. X-Derive-* response headers double as a capability probe for older
  // clients that predate these params (self-hosted stdio server parity).
  app.get("/v1/artifacts/:shortId/content", async (c) => {
    const artifact = await requireArtifact(c, "read")
    if (artifact instanceof Response) return artifact
    if (artifact.current_version === 0) return fail(c, 404, "not found")
    if (artifact.removed_at) return fail(c, 410, TOMBSTONE)
    const vq = c.req.query("v")
    const v = vq ? Number(vq) : artifact.current_version
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
      if (format === "text")
        return isHtmlLike(contentType)
          ? pageText(source)
          : isLatexLike(contentType)
            ? latexTextParts(source).text
            : source
      return elideDataUris(toMarkdown(source, contentType))
    }

    c.header("Access-Control-Allow-Origin", "*")
    c.header("X-Content-Type-Options", "nosniff")
    c.header("X-Derive-Version", String(v))
    c.header("X-Derive-Kind", artifact.kind)
    // The DOCUMENT'S type, which `Content-Type` deliberately cannot carry: that stays
    // `text/plain` so a browser renders these bytes rather than executing them (see nosniff
    // above). Without it, a caller that needs to know whether it is holding Markdown or HTML
    // must fetch the artifact record separately — a second request that re-runs auth and
    // re-reads the very row this handler already has in hand and uses six lines below.
    //
    // Per VERSION, not the artifact's current one: `?v=N` can select a version whose type
    // differs from the live document's, and this has to describe the bytes actually returned.
    c.header("X-Derive-Content-Type", version.content_type)

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
    // text/plain covers a paper's .bib, .sty, .cls and .bst files.
    const isText =
      fileBaseType === "text/html" ||
      fileBaseType === "text/markdown" ||
      fileBaseType === "text/x-latex" ||
      fileBaseType === "text/plain"
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

  // Live editor preview: render a markdown or LaTeX draft to the exact published HTML.
  // Stateless (renders the caller's text, stores nothing) and signed-in only, so
  // it can't be used as an anonymous render farm. HTML drafts preview in the
  // browser, so this covers the two source languages that need a render.
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/preview",
      tags: ["Artifacts"],
      summary:
        "Render a markdown or LaTeX draft to the exact published HTML (stateless; signed-in only).",
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
        z.object({
          source: z.string().max(500_000),
          title: z.string().max(300).nullish(),
          // Defaults to markdown, the only draft the route used to take; a .tex draft
          // names its type to reach the LaTeX renderer.
          content_type: z.enum(["text/markdown", "text/x-latex"]).optional(),
        }),
      )
      if (body instanceof Response) return bail(body)
      const html =
        body.content_type === "text/x-latex"
          ? renderLatex(body.source, body.title ?? null).html
          : await renderMarkdown(body.source, body.title ?? null)
      return c.json({ html })
    },
  )

  // Line diff between two versions. Defaults to (current-1 → current).
  // ?format=json returns the structured ops; otherwise unified-style text.
  app.get("/v1/artifacts/:shortId/diff", async (c) => {
    const artifact = await requireArtifact(c, "read")
    if (artifact instanceof Response) return artifact
    if (artifact.current_version === 0) return fail(c, 404, "not found")
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
