import { can, normalizeUsername, toJson, usernameError } from "@derive/core"
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { Context } from "hono"
import type { BlankEnv } from "hono/types"
import type { AppContext } from "../context"
import { authorProfile, resolveHandles } from "../lib/author"
import { bail, fail, IMMUTABLE_CACHE, readJson, toBody } from "../lib/http"
import { MAX_AVATAR_BYTES, sniffImageType } from "../lib/image"
import { Artifact } from "../schemas"

/** Session identity + the workspace member/agent directory for the @mention picker.
 *  PublicProfile + DirUser are generated for the web; `Me` stays a web-side mapped type
 *  (the /v1/me payload is a SessionUser + role that the client's mapMe() folds together
 *  with Better Auth's session, so it isn't a verbatim backend shape). */
export const sessionRoutes = (ctx: AppContext) => {
  const {
    meta,
    blobs,
    deps,
    isMember,
    isToken,
    requireUser,
    currentUser,
    ensureMembership,
    activeWorkspace,
    authorize,
    actorFor,
    analyticsOn,
  } = ctx
  const app = new OpenAPIHono<BlankEnv>()

  // A personal Brandprint: a pointer to a conventions collection, plus an optional
  // visual theme for rendered docs. Mirrors the workspace-level shape (resolved
  // profile-over-workspace); see packages/core/src/ports.ts Brandprint.
  const BrandprintTheme = z.object({
    palette: z.record(z.string(), z.string()).optional(),
    fonts: z.record(z.string(), z.string()).optional(),
    dark: z.object({ palette: z.record(z.string(), z.string()).optional() }).optional(),
  })
  const BrandprintSchema = z.object({
    collectionId: z.string().trim().max(64).nullish(),
    theme: BrandprintTheme.nullish(),
  })

  // A public profile by @handle — email is intentionally omitted. The list surfaces
  // (search/people/followers/following) carry the top fields; the full /users/:handle
  // profile adds about/github_login/stats/followed_by_me.
  const PublicProfile = z
    .object({
      username: z.string(),
      name: z.string().nullable(),
      image: z.string().nullable().describe("Avatar URL; null if none is set."),
      profession: z
        .string()
        .nullable()
        .optional()
        .describe("Self-set team role ('what you do'); null if unset."),
      about: z
        .string()
        .nullable()
        .optional()
        .describe("One-line bio; on the full profile only, null if unset."),
      github_login: z
        .string()
        .nullable()
        .optional()
        .describe("Linked GitHub login; full profile only, null if not linked."),
      teammate: z
        .boolean()
        .optional()
        .describe("True when the viewer shares a workspace with this user."),
      stats: z
        .object({ works: z.number() })
        .optional()
        .describe("Authored-works count; present only for teammates."),
      followed_by_me: z
        .boolean()
        .optional()
        .describe("Whether the signed-in viewer follows this user."),
    })
    .openapi("PublicProfile")

  // A person or agent offered by the @mention picker — by @handle, never email.
  const DirUser = z
    .object({
      id: z.string().describe("User id, or the agent id when kind is agent."),
      name: z.string().nullable(),
      handle: z
        .string()
        .nullable()
        .describe("The @handle; null for agents (and users without one)."),
      kind: z
        .enum(["user", "agent"])
        .optional()
        .describe("Whether this entry is a person (user) or an agent."),
      profession: z.string().nullable().optional().describe("The person's role; null for agents."),
    })
    .openapi("DirUser")

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/me",
      tags: ["Session"],
      summary: "The signed-in user + their active-workspace role.",
      responses: {
        200: {
          description: "The current user (SessionUser + role) and whether multi-workspace is on.",
          content: {
            "application/json": {
              schema: z.object({
                user: z.object({
                  id: z.string(),
                  email: z.string(),
                  name: z.string().nullable(),
                  username: z
                    .string()
                    .nullable()
                    .describe("The @handle; null until claimed at onboarding."),
                  discoverable: z
                    .boolean()
                    .describe("Whether the user is findable in people search."),
                  profession: z.string().nullable().describe("Self-set team role; null if unset."),
                  about: z.string().nullable().describe("One-line bio; null if unset."),
                  onboarded: z.boolean().describe("Whether first-run onboarding is complete."),
                  emailVerified: z.boolean().describe("Whether the account email is verified."),
                  role: z
                    .string()
                    .describe(
                      "The caller's role in the active workspace: viewer, commenter, editor, or owner (Admin).",
                    ),
                }),
                multi: z.boolean().describe("Whether multi-workspace mode is enabled."),
              }),
            },
          },
        },
      },
    }),
    async (c) => {
      const u = await requireUser(c)
      if (u instanceof Response) return bail(u)
      const role = await ensureMembership(await activeWorkspace(c), u.id) // provisions on first load
      return c.json({ user: { ...u, role }, multi: true })
    },
  )

  // Claim or change your handle (Profiles & Accounts v1) — the prompt shown at
  // onboarding, and re-runnable to rename later. Server-validated (shape +
  // reserved words) and lowercased before storage; a clash with another account
  // is a 409. Only the signed-in user can set their own (the anon-write lockdown
  // already blocks unauthenticated POSTs).
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/me/username",
      tags: ["Session"],
      summary: "Claim or change your @handle.",
      responses: {
        200: {
          description: "The new handle.",
          content: { "application/json": { schema: z.object({ username: z.string() }) } },
        },
      },
    }),
    async (c) => {
      const u = await requireUser(c)
      if (u instanceof Response) return bail(u)
      const body = await readJson(c, z.object({ username: z.string() }))
      if (body instanceof Response) return bail(body)
      const username = normalizeUsername(body.username)
      const err = usernameError(username)
      if (err) return bail(fail(c, 400, err))
      const res = await meta.setUsername(u.id, username)
      if (res === "taken") return bail(fail(c, 409, "That username is taken."))
      return c.json({ username })
    },
  )

  // Set your team role + "what you do" blurb (Settings → Profile, and onboarding).
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/me/profile",
      tags: ["Session"],
      summary: "Set your team role + one-line bio.",
      responses: {
        200: {
          description: "The saved profession + about (null clears a field).",
          content: {
            "application/json": {
              schema: z.object({
                profession: z.string().nullable().describe("Saved team role; null when cleared."),
                about: z.string().nullable().describe("Saved bio; null when cleared."),
                brandprint: BrandprintSchema.nullable().describe(
                  "Saved personal Brandprint; null when cleared.",
                ),
              }),
            },
          },
        },
      },
    }),
    async (c) => {
      const u = await requireUser(c)
      if (u instanceof Response) return bail(u)
      const body = await readJson(
        c,
        z.object({
          profession: z.string().trim().max(40).optional(),
          about: z.string().trim().max(280).optional(),
          brandprint: BrandprintSchema.nullable().optional(),
        }),
      )
      if (body instanceof Response) return bail(body)
      // Normalize "" → null (clear) so the column is never an empty string.
      const patch: {
        profession?: string | null
        about?: string | null
        brandprint?: string | null
      } = {}
      if (body.profession !== undefined) patch.profession = body.profession || null
      if (body.about !== undefined) patch.about = body.about || null
      if (body.brandprint !== undefined)
        patch.brandprint = body.brandprint ? JSON.stringify(body.brandprint) : null
      await meta.setUserProfile(u.id, patch)
      return c.json({
        profession: patch.profession ?? null,
        about: patch.about ?? null,
        brandprint: body.brandprint ?? null,
      })
    },
  )

  // Opt in/out of being findable.
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/me/discoverable",
      tags: ["Session"],
      summary: "Opt in/out of being findable in people search.",
      responses: {
        200: {
          description: "The new discoverability.",
          content: { "application/json": { schema: z.object({ discoverable: z.boolean() }) } },
        },
      },
    }),
    async (c) => {
      const u = await requireUser(c)
      if (u instanceof Response) return bail(u)
      const body = await readJson(c, z.object({ discoverable: z.boolean() }))
      if (body instanceof Response) return bail(body)
      await meta.setUserDiscoverable(u.id, body.discoverable)
      return c.json({ discoverable: body.discoverable })
    },
  )

  // Mark first-run onboarding finished (server-authoritative). One-way, no body.
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/me/onboarded",
      tags: ["Session"],
      summary: "Mark first-run onboarding finished (server-authoritative).",
      responses: {
        200: {
          description: "Onboarded.",
          content: { "application/json": { schema: z.object({ onboarded: z.boolean() }) } },
        },
      },
    }),
    async (c) => {
      const u = await requireUser(c)
      if (u instanceof Response) return bail(u)
      await meta.setUserOnboarded(u.id, true)
      return c.json({ onboarded: true })
    },
  )

  // People search: find OPTED-IN accounts by handle or name. Registered before
  // /v1/users/:handle so "search" isn't read as a handle.
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/users/search",
      tags: ["Session"],
      summary: "Search opted-in accounts by handle or name.",
      responses: {
        200: {
          description: "Matching public profiles (public fields only).",
          content: { "application/json": { schema: z.object({ users: z.array(PublicProfile) }) } },
        },
      },
    }),
    async (c) => {
      if (!(await currentUser(c))) return bail(fail(c, 401, "unauthenticated"))
      const q = (c.req.query("query") ?? "").trim()
      if (!q) return c.json({ users: [] })
      const found = await meta.searchDiscoverableUsers(q, 20)
      return c.json({
        users: found.map((u) => ({
          username: u.username,
          name: u.name,
          image: u.image,
          profession: u.profession ?? null,
        })),
      })
    },
  )

  // The People page's data — the people you actually work with (any shared
  // workspace), discoverable or not: membership already implies you can see each
  // other. There is deliberately no global directory here — People is work
  // awareness, not a social network (addressing a stranger to SHARE with them
  // still works via /v1/users/search, which never enumerates). `?query=` filters
  // within your workmates. Signed-in only; public fields only — never email.
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/people",
      tags: ["Session"],
      summary: "Browse the people you work with (optionally filtered by ?query=).",
      responses: {
        200: {
          description: "Public profiles (public fields only).",
          content: { "application/json": { schema: z.object({ users: z.array(PublicProfile) }) } },
        },
      },
    }),
    async (c) => {
      const me = await currentUser(c)
      if (!me) return bail(fail(c, 401, "unauthenticated"))
      const q = (c.req.query("query") ?? "").trim().toLowerCase()
      const mates = await meta.listWorkspaceMates(me.id, 60)
      const found = q
        ? mates.filter(
            (u) =>
              u.username?.toLowerCase().includes(q) ||
              u.name?.toLowerCase().includes(q) ||
              u.profession?.toLowerCase().includes(q),
          )
        : mates
      return c.json({
        users: found.map((u) => ({
          username: u.username,
          name: u.name,
          image: u.image,
          profession: u.profession ?? null,
        })),
      })
    },
  )

  // Whether this viewer may see this profile at all.
  const profileVisibleTo = async (
    c: Context,
    p: { id: string; discoverable?: boolean | number | null },
  ): Promise<boolean> => {
    if (p.discoverable !== false && p.discoverable !== 0) return true
    const me = await currentUser(c)
    if (!me) return false
    if (me.id === p.id) return true
    return (await meta.sharedOrgIds(me.id, p.id)).length > 0
  }

  // A public profile by handle — the GitHub-style discovery surface.
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/users/{handle}",
      tags: ["Session"],
      summary: "A public profile by @handle (email never returned).",
      request: { params: z.object({ handle: z.string() }) },
      responses: {
        200: {
          description: "The public profile with stats + follow state.",
          content: { "application/json": { schema: z.object({ user: PublicProfile }) } },
        },
      },
    }),
    async (c) => {
      const handle = normalizeUsername(c.req.param("handle"))
      const p = await meta.getUserByUsername(handle)
      if (!p) return bail(fail(c, 404, "no profile with that username"))
      if (!(await profileVisibleTo(c, p)))
        return bail(fail(c, 404, "no profile with that username"))
      const me = await currentUser(c)
      // sharedOrgIds(x, x) is all of x's workspaces — self is trivially a teammate.
      const sharedOrgs = me ? await meta.sharedOrgIds(me.id, p.id) : []
      const teammate = !!me && (me.id === p.id || sharedOrgs.length > 0)
      const ghIds = await meta.githubIdsForUser(p.id)
      const [works, githubLogin] = await Promise.all([
        teammate ? meta.countUserWorks(p.id, ghIds, { visibleOrgIds: sharedOrgs }) : 0,
        meta.githubLoginForUser(p.id, ghIds),
      ])
      // Already following? People-follows are global, so listFollows (which folds in the
      // org "*" rows) carries them regardless of the viewer's active workspace.
      let followedByMe = false
      if (me && me.id !== p.id) {
        const mine = await meta.listFollows(me.id, await activeWorkspace(c))
        followedByMe = mine.some((f) => f.kind === "user" && f.target === p.id)
      }
      return c.json({
        user: {
          username: p.username,
          name: p.name,
          image: p.image,
          profession: p.profession ?? null,
          about: p.about ?? null,
          github_login: githubLogin,
          teammate,
          ...(teammate ? { stats: { works } } : {}),
          followed_by_me: followedByMe,
        },
      })
    },
  )

  // A person's work — the artifacts they've authored, as the shared Artifact view-model
  // (the same schema the artifacts router emits; drives their public profile grid).
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/users/{handle}/artifacts",
      tags: ["Session"],
      summary: "A user's authored artifacts (keyset-paginated).",
      request: { params: z.object({ handle: z.string() }) },
      responses: {
        200: {
          description: "A page of the user's artifacts + next cursor.",
          content: {
            "application/json": {
              schema: z.object({
                artifacts: z.array(Artifact),
                next_cursor: z
                  .string()
                  .nullable()
                  .describe("Opaque cursor for the next page; null when there are no more."),
              }),
            },
          },
        },
      },
    }),
    async (c) => {
      const p = await meta.getUserByUsername(normalizeUsername(c.req.param("handle")))
      if (!p) return bail(fail(c, 404, "no profile with that username"))
      if (!(await profileVisibleTo(c, p)))
        return bail(fail(c, 404, "no profile with that username"))
      const me = await currentUser(c)
      // sharedOrgIds(x, x) is all of x's workspaces — self always sees their own work.
      const sharedOrgs = me ? await meta.sharedOrgIds(me.id, p.id) : []
      if (!me || (me.id !== p.id && sharedOrgs.length === 0))
        return c.json({ artifacts: [], next_cursor: null })
      const ghIds = await meta.githubIdsForUser(p.id)
      const limit = Math.min(50, Math.max(1, Number(c.req.query("limit")) || 24))
      const rawCursor = c.req.query("cursor")
      const sep = rawCursor?.indexOf("|") ?? -1
      const cursor =
        rawCursor && sep > 0
          ? { created_at: rawCursor.slice(0, sep), id: rawCursor.slice(sep + 1) }
          : undefined
      const rows = await meta.listUserWorks(p.id, ghIds, {
        limit: limit + 1,
        cursor,
        visibleOrgIds: sharedOrgs,
      })
      const hasMore = rows.length > limit
      const page = hasMore ? rows.slice(0, limit) : rows
      const last = page[page.length - 1]
      const next_cursor = hasMore && last ? `${last.created_at}|${last.id}` : null
      const pageIds = page.map((a) => a.id)
      const counts = analyticsOn ? await meta.viewCounts(pageIds) : {}
      const tags = await meta.tagsForArtifacts(pageIds)
      const previews = await meta.previewReady(pageIds)
      const handleByGhId = await resolveHandles(meta, [
        ...new Set(page.map((a) => a.author_gh_id).filter((x): x is string => !!x)),
      ])
      return c.json({
        artifacts: page.map((a) => ({
          ...toJson(deps.baseUrl, a, []),
          views: counts[a.id] ?? 0,
          tags: tags[a.id] ?? [],
          has_preview: previews[a.id] === true,
          author: authorProfile(a, handleByGhId),
        })),
        next_cursor,
      })
    },
  )

  // (The followers/following list routes were removed with the launch social cut —
  // the follow graph is deliberately not a browsable surface, for anyone.)

  // Upload your profile picture (raster only, identified by magic bytes).
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/me/avatar",
      tags: ["Session"],
      summary: "Upload your profile picture (multipart; raster images only).",
      responses: {
        200: {
          description: "The served avatar URL.",
          content: {
            "application/json": {
              schema: z.object({
                image: z.string().describe("The served (absolute) avatar URL."),
              }),
            },
          },
        },
      },
    }),
    async (c) => {
      const u = await requireUser(c)
      if (u instanceof Response) return bail(u)
      const len = Number(c.req.header("content-length") ?? 0)
      if (len > MAX_AVATAR_BYTES + 4096) return bail(fail(c, 413, "image too large (max 2MB)"))
      const body = await c.req.parseBody()
      const file = body.file
      if (!(file instanceof File)) return bail(fail(c, 400, "multipart field 'file' required"))
      const bytes = new Uint8Array(await file.arrayBuffer())
      if (bytes.byteLength > MAX_AVATAR_BYTES)
        return bail(fail(c, 413, "image too large (max 2MB)"))
      // Trust the bytes, not the declared type — and reject anything that isn't a
      // plain raster image (no SVG: it could carry script served from our origin).
      if (!sniffImageType(bytes))
        return bail(fail(c, 400, "unsupported image (use PNG, JPEG, GIF, or WebP)"))
      const key = await blobs.put(bytes)
      // Absolute URL so it resolves from the API origin even when the SPA is served
      // from a separate origin (hosted split); the bytes never touch the app cookie.
      const image = `${deps.baseUrl.replace(/\/$/, "")}/v1/avatars/${key}`
      await meta.setUserImage(u.id, image)
      return c.json({ image })
    },
  )

  // Serve an avatar blob. Binary + immutable — stays a plain route.
  app.get("/v1/avatars/:key", async (c) => {
    const bytes = await blobs.get(c.req.param("key"))
    if (!bytes) return fail(c, 404, "not found")
    const type = sniffImageType(bytes)
    if (!type) return fail(c, 404, "not found")
    return c.body(toBody(bytes), 200, { "Content-Type": type, "Cache-Control": IMMUTABLE_CACHE })
  })

  // Directory for the @mention picker — people AND agents. Authenticated callers only.
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/users",
      tags: ["Session"],
      summary: "The @mention directory: workspace people + agents (auth only).",
      responses: {
        200: {
          description: "Mentionable people + agents (by @handle, never email).",
          content: { "application/json": { schema: z.object({ users: z.array(DirUser) }) } },
        },
      },
    }),
    async (c) => {
      const me = await currentUser(c)
      if (!me && !isToken(c)) return bail(fail(c, 401, "unauthenticated"))
      const q = (c.req.query("query") ?? "").trim().toLowerCase()

      const shortId = c.req.query("artifact")
      const found = shortId ? await meta.getByShortId(shortId) : null
      const artifact = found && (await authorize(c, "read", found)) ? found : null
      const org = artifact ? artifact.org_id : await activeWorkspace(c)

      const ids = new Set<string>()
      if (me) ids.add(me.id) // you can always @mention yourself
      const isOrgMember = await isMember(c, org)
      if (isOrgMember) for (const m of await meta.listMemberships(org)) ids.add(m.user_id)
      if (
        artifact &&
        (isToken(c) ||
          can(
            await actorFor(c, artifact),
            "comment",
            artifact.workspace_access,
            artifact.link_role,
          ))
      ) {
        for (const m of await meta.listArtifactMembers(artifact.id)) ids.add(m.user_id)
        for (const cm of await meta.listComments(artifact.id))
          if (cm.author_id) ids.add(cm.author_id)
      }

      const users = await meta.getUsers([...ids])
      const people = (
        q
          ? users.filter(
              (u) =>
                (u.name ?? "").toLowerCase().includes(q) ||
                (u.username ?? "").includes(q) ||
                u.email.toLowerCase().includes(q),
            )
          : users
      ).map((u) => ({
        id: u.id,
        handle: u.username,
        name: u.name,
        kind: "user" as const,
        profession: u.profession ?? null,
      }))
      const agents = (await meta.listAgents(org))
        .filter((ag) => !q || ag.name.toLowerCase().includes(q))
        .map((ag) => ({
          id: ag.id,
          handle: null,
          name: ag.name,
          kind: "agent" as const,
          profession: null,
        }))
      const all = [...people, ...agents].sort((a, b) =>
        (a.name ?? a.handle ?? "").localeCompare(b.name ?? b.handle ?? ""),
      )
      return c.json({ users: all })
    },
  )

  return app
}
