import type { GitHubAppRecord, RepoSourceRecord, SyncProgress } from "@derive/core"
import { newId } from "@derive/core"
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { BlankEnv } from "hono/types"
import type { AppContext } from "../context"
import { REQUIRED_EVENTS, REQUIRED_PERMISSIONS } from "../github-app-setup"
import { decryptSecret, encryptSecret, signState, verifyState } from "../lib/crypto"
import { GitHubError, listPullFiles, listTree, matchesGlobs, parseRepo } from "../lib/github"
import {
  getAppInfo,
  installationToken,
  listAppInstallations,
  listInstallationRepos,
  verifyWebhookSignature,
} from "../lib/github-app"
import { ingestGithubPrComment, upsertPreviewComment } from "../lib/github-comments"
import { bail, fail, readJson } from "../lib/http"
import { makePrPreview } from "../lib/pr-preview"
import { effectiveToken, isSyncing, runToCompletion } from "../lib/sync-runner"
import { log } from "../log"

const DEFAULT_INCLUDES = "**/*.md,**/*.html"

/** Client-safe view of a source: the token is redacted and the (potentially large)
 *  file map collapses to a count. The live `progress` JSON rides through in `...rest`
 *  so the UI can render the bar straight off the list/status response. */
const toJson = (s: RepoSourceRecord) => {
  let file_count = 0
  try {
    file_count = Object.keys(JSON.parse(s.files || "{}")).length
  } catch {
    // malformed map → report 0; the next sync rewrites it
  }
  const { token, files: _files, ...rest } = s
  return { ...rest, token: token ? "•••" : null, file_count }
}

/** The initial "queued" progress, written the instant a sync is triggered so the UI
 *  shows the bar at once — before the first batch even lists the tree. */
const queuedProgress = (now: string): string =>
  JSON.stringify({ phase: "queued", done: 0, total: 0, updatedAt: now } satisfies SyncProgress)

/** A GitHub redirect bound to the workspace + user who started the install. */
interface InstallState {
  org: string
  uid: string
  iat: number
}

interface GitHubWebhookPayload {
  action?: string
  ref?: string
  installation?: { id?: number; account?: { login?: string } }
  repository?: { full_name?: string; default_branch?: string }
  // `pull_request` events (PR previews). `head.sha` is the ref we mirror at; `number`
  // + `title` name the preview collection; `merged` decides graduate vs teardown on
  // close. `head.ref`/`base.ref` are unused today.
  pull_request?: {
    number?: number
    title?: string
    merged?: boolean
    head?: { sha?: string; ref?: string }
    base?: { ref?: string }
  }
  // `issue_comment` (PR conversation) + `pull_request_review_comment` (inline) — mirrored
  // back into the Derive artifact. `issue.pull_request` presence confirms a PR (not a plain
  // issue); the review-comment variant carries `path`/`diff_hunk` for anchoring.
  issue?: { number?: number; pull_request?: unknown }
  comment?: {
    id?: number
    body?: string
    path?: string
    diff_hunk?: string
    user?: { login?: string; type?: string }
  }
}

/**
 * Sync from GitHub: mirror a repo's Markdown/HTML into a collection, one-way.
 * Two ways in — a GitHub App (install → pick repos → push auto-sync, no stored
 * secret) or a pasted read-only PAT (self-host without an App). Synced artifacts
 * are read-only (the gate lives in the publish/propose routes); this manages the
 * connection, the App install handshake, and drives the engine (lib/sync). The
 * RepoSource / PrPreview / GithubSyncStatus / … schemas are the single source for
 * the web client's types. The install callback (a browser redirect) and the webhook
 * (a GitHub server-to-server callback) stay plain routes.
 */
export const syncRoutes = (ctx: AppContext) => {
  const { meta, deps, bus, currentUser, activeWorkspace, workspaceCan, background } = ctx
  const app = new OpenAPIHono<BlankEnv>()

  const RepoSource = z
    .object({
      id: z.string(),
      collection_id: z.string(),
      repo: z.string(),
      ref: z.string(),
      includes: z.string(),
      token: z.string().nullable(),
      installation_id: z.string().nullable(),
      last_synced_at: z.string().nullable(),
      last_status: z.string().nullable(),
      created_by: z.string(),
      created_at: z.string(),
      file_count: z.number(),
      progress: z.string().nullable(),
    })
    .openapi("RepoSource")

  const PrPreview = z
    .object({
      id: z.string(),
      collection_id: z.string(),
      repo: z.string(),
      pr_number: z.number(),
      title: z.string(),
      last_status: z.string().nullable(),
      last_synced_at: z.string().nullable(),
      file_count: z.number(),
      progress: z.string().nullable(),
    })
    .openapi("PrPreview")

  const GithubInstallation = z
    .object({ installation_id: z.string(), account_login: z.string().nullable() })
    .openapi("GithubInstallation")

  const InstallationRepo = z
    .object({
      full_name: z.string(),
      private: z.boolean(),
      default_branch: z.string(),
      pushed_at: z.string().nullable(),
    })
    .openapi("InstallationRepo")

  const SyncPreview = z
    .object({
      total: z.number(),
      md: z.number(),
      html: z.number(),
      other: z.number(),
      truncated: z.boolean(),
    })
    .openapi("SyncPreview")

  const SyncStatus = z
    .object({
      id: z.string(),
      repo: z.string(),
      progress: z.string().nullable(),
      last_status: z.string().nullable(),
      last_synced_at: z.string().nullable(),
      file_count: z.number(),
    })
    .openapi("SyncStatus")

  const GithubSyncStatus = z
    .object({
      sources: z.array(RepoSource),
      prs: z.array(PrPreview),
      app: z.object({
        configured: z.boolean(),
        slug: z.string().optional(),
        upToDate: z.boolean().optional(),
        missing: z
          .object({ permissions: z.record(z.string(), z.string()), events: z.array(z.string()) })
          .optional(),
        permissionsUrl: z.string().optional(),
        approveUrl: z.string().optional(),
      }),
      installations: z.array(GithubInstallation),
    })
    .openapi("GithubSyncStatus")

  // The instance App, with its three secret columns decrypted for use. Null when
  // setup hasn't run (the UI then offers the PAT path). The App flow needs an
  // encryptionKey (App secrets are never stored in the clear), so it's the gate too.
  const loadApp = async (): Promise<{
    app: GitHubAppRecord
    pem: string
    webhookSecret: string
  } | null> => {
    if (!deps.encryptionKey) return null
    const found = await meta.getGithubApp()
    if (!found) return null
    const key = deps.encryptionKey
    return {
      app: found,
      pem: decryptSecret(found.private_key, key),
      webhookSecret: decryptSecret(found.webhook_secret, key),
    }
  }

  // Is the stored App still live on GitHub, and what permissions/events does it
  // currently hold? An App the owner deleted on GitHub leaves a stale row here,
  // which would strand the UI on "Install" pointing at a dead slug with no way
  // back. We verify against GitHub (GET /app) and cache the verdict + live spec
  // ~5min per isolate so this isn't a per-request call. On success we also
  // self-heal the slug if it drifted (the App was renamed). A network blip is
  // treated as "live" (fail-open) so a transient error never hides a good App;
  // its permissions are unknown then, so the diff treats it as up-to-date.
  type AppLive = { ok: boolean; permissions?: Record<string, string>; events?: string[] }
  const appLiveCache = new Map<string, AppLive & { at: number }>()
  const appIsLive = async (loaded: { app: GitHubAppRecord; pem: string }): Promise<AppLive> => {
    const cached = appLiveCache.get(loaded.app.app_id)
    if (cached && Date.now() - cached.at < 5 * 60_000) return cached
    try {
      const info = await getAppInfo(loaded.app.app_id, loaded.pem)
      if (info.slug && info.slug !== loaded.app.slug)
        await meta.setGithubApp({ ...loaded.app, slug: info.slug })
      const live: AppLive = { ok: true, permissions: info.permissions, events: info.events }
      appLiveCache.set(loaded.app.app_id, { ...live, at: Date.now() })
      return live
    } catch (err) {
      // 404/401 → deleted or revoked: definitively dead. Anything else (network,
      // 5xx) → keep trusting the stored App rather than hide a working setup.
      const dead = err instanceof GitHubError && (err.status === 404 || err.status === 401)
      if (!dead) return { ok: true }
      const live: AppLive = { ok: false }
      appLiveCache.set(loaded.app.app_id, { ...live, at: Date.now() })
      return live
    }
  }

  // Diff Derive's REQUIRED spec against the App's live permissions/events. A scope is
  // "missing" if absent OR weaker than required (read < write < admin). When the live
  // spec is unknown (a fail-open network blip), report nothing missing rather than
  // nag spuriously. Drives the in-app "update permissions" banner.
  const permRank: Record<string, number> = { read: 1, write: 2, admin: 3 }
  const diffAppSpec = (
    live: AppLive,
  ): { permissions: Record<string, string>; events: string[] } => {
    const permissions: Record<string, string> = {}
    const events: string[] = []
    if (live.permissions) {
      for (const [scope, level] of Object.entries(REQUIRED_PERMISSIONS)) {
        const have = live.permissions[scope]
        if (!have || (permRank[level] ?? 0) > (permRank[have] ?? 0)) permissions[scope] = level
      }
    }
    if (live.events) {
      for (const ev of REQUIRED_EVENTS) if (!live.events.includes(ev)) events.push(ev)
    }
    return { permissions, events }
  }

  // Trigger a sync on the SERVER, not in the browser — so it survives the user
  // closing the tab (their #1 complaint). Marks the source `queued` (the UI shows the
  // bar immediately) and hands off to the background runner: the per-source
  // `RepoSyncRunner` Durable Object on the edge, or the detached batch-loop on Node
  // (both via `deps.startSync`). Token minting + the per-batch engine loop live in
  // lib/sync-runner, shared by every tier. When no runner is wired (tests/dev),
  // `inlineFallback` runs the whole sync in the background instead, so a self-host
  // without a runner still mirrors. The engine persists progress every batch, polled
  // by the UI.
  const launch = async (source: RepoSourceRecord, inlineFallback: boolean): Promise<void> => {
    await meta.setRepoSourceProgress(source.id, queuedProgress(new Date().toISOString()))
    if (deps.startSync) deps.startSync(source.id)
    else if (inlineFallback)
      background(runToCompletion(meta, deps.blobs, deps.encryptionKey, source.id))
  }

  // PR-preview lifecycle (create/update/tear-down/graduate) lives in its own module —
  // it's collection/blob orchestration the webhook drives, not routing.
  const { upsertPrPreview, previewCommentBody, removePrPreview, graduatePreview } = makePrPreview({
    meta,
    blobs: deps.blobs,
    baseUrl: deps.baseUrl,
    launch,
  })

  // ---- Resync installations from GitHub ---------------------------------
  // Fetches all installations of this App from GitHub and upserts them into the
  // current workspace. Useful for recovery when the `github_installation` table
  // loses rows (e.g. after a DB wipe) without needing to re-click through GitHub.
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/sync/github/resync-installations",
      tags: ["Sync"],
      summary: "Re-import this App's installations from GitHub (Admin only).",
      responses: {
        200: {
          description: "How many installations were re-imported.",
          content: { "application/json": { schema: z.object({ synced: z.number() }) } },
        },
      },
    }),
    async (c) => {
      if (!(await workspaceCan(c, "publish"))) return bail(fail(c, 403, "forbidden"))
      const loaded = await loadApp()
      if (!loaded) return bail(fail(c, 409, "GitHub App is not set up yet"))
      const org = await activeWorkspace(c)
      const uid = (await currentUser(c))?.id ?? "anon"
      try {
        const installs = await listAppInstallations(loaded.app.app_id, loaded.pem)
        for (const inst of installs) {
          await meta.upsertGithubInstallation({
            installation_id: String(inst.id),
            org_id: org,
            account_login: inst.account?.login ?? null,
            created_by: uid,
            created_at: new Date().toISOString(),
          })
        }
        return c.json({ synced: installs.length })
      } catch (err) {
        return bail(fail(c, 502, err instanceof Error ? err.message : "resync failed"))
      }
    },
  )

  // ---- List + connection status -----------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/sync/github",
      tags: ["Sync"],
      summary: "The workspace's synced repos, PR previews, App status, and installations.",
      responses: {
        200: {
          description: "Branch sources, PR previews, the App's setup/permissions, installations.",
          content: { "application/json": { schema: GithubSyncStatus } },
        },
      },
    }),
    async (c) => {
      if (!(await workspaceCan(c, "comment"))) return bail(fail(c, 403, "forbidden"))
      const org = await activeWorkspace(c)
      const [sources, installs, loaded] = await Promise.all([
        meta.listRepoSources(org),
        meta.listGithubInstallations(org),
        loadApp(),
      ])
      // A configured App that GitHub no longer knows about (deleted) reports as
      // unconfigured, so the UI shows "Set up" again instead of a dead Install link.
      const live = loaded ? await appIsLive(loaded) : { ok: false }
      // Split branch mirrors from PR previews — the UI lists them in separate groups.
      // A preview carries its PR number; its collection title ("PR #<n>: <title>") names it.
      const branchSources = sources.filter((s) => s.pr_number == null)
      const previews = sources.filter(
        (s): s is RepoSourceRecord & { pr_number: number } => s.pr_number != null,
      )
      const previewCols = await Promise.all(
        previews.map((s) => meta.getCollection(s.collection_id)),
      )
      return c.json({
        sources: branchSources.map(toJson),
        prs: previews.map((s, i) => ({
          ...toJson(s),
          pr_number: s.pr_number,
          title: previewCols[i]?.title ?? `PR #${s.pr_number}`,
        })),
        // What the UI needs to pick its entry point: is a live App set up (→ Connect
        // button + slug for the install link), which permissions still need granting
        // (→ the update-permissions banner), and which installations this workspace
        // already has (→ jump straight to the repo picker).
        app:
          loaded && live.ok
            ? (() => {
                const missing = diffAppSpec(live)
                const upToDate =
                  Object.keys(missing.permissions).length === 0 && missing.events.length === 0
                return {
                  configured: true,
                  slug: loaded.app.slug,
                  upToDate,
                  missing,
                  permissionsUrl: `https://github.com/settings/apps/${loaded.app.slug}/permissions`,
                  approveUrl: `https://github.com/apps/${loaded.app.slug}/installations/new`,
                }
              })()
            : { configured: false },
        installations: installs.map((i) => ({
          installation_id: i.installation_id,
          account_login: i.account_login,
        })),
      })
    },
  )

  // ---- App install: hand back the GitHub install URL --------------------
  // The SPA navigates the browser to this URL; GitHub walks the user through
  // picking repos, then redirects to /v1/sync/github/callback with our state.
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/sync/github/install",
      tags: ["Sync"],
      summary: "Get the GitHub App install URL for this workspace (Admin only).",
      responses: {
        200: {
          description: "The GitHub install URL to navigate the browser to.",
          content: { "application/json": { schema: z.object({ url: z.string() }) } },
        },
      },
    }),
    async (c) => {
      if (!(await workspaceCan(c, "publish"))) return bail(fail(c, 403, "forbidden"))
      const loaded = await loadApp()
      if (!loaded) return bail(fail(c, 409, "GitHub App is not set up yet"))
      const org = await activeWorkspace(c)
      const uid = (await currentUser(c))?.id ?? "anon"
      const state = signState({ org, uid }, deps.encryptionKey as string)
      const url = `https://github.com/apps/${encodeURIComponent(
        loaded.app.slug,
      )}/installations/new?state=${encodeURIComponent(state)}`
      return c.json({ url })
    },
  )

  // ---- App install callback (GitHub → browser redirect) -----------------
  // GET, so it passes the anonymous-write lockdown. Primary auth is the signed
  // state Derive embeds in the install URL — it carries the workspace. A present-
  // but-invalid state (tampered or expired) is REJECTED — that's the CSRF guard.
  // An ABSENT state is the legitimate "installed directly on GitHub" path (the
  // App's setup_url fires with no state); there we fall back to the session's
  // active workspace so the install is recorded rather than silently dropped.
  // Plain route: a browser redirect, not typed JSON.
  app.get("/v1/sync/github/callback", async (c) => {
    const installationId = c.req.query("installation_id")
    const stateRaw = c.req.query("state") ?? ""
    const settingsUrl = new URL("/settings/github", deps.baseUrl)
    if (!deps.encryptionKey || !installationId) {
      settingsUrl.searchParams.set("gh_error", "install_failed")
      return c.redirect(settingsUrl.toString())
    }
    const state = verifyState<InstallState>(stateRaw, deps.encryptionKey)
    // State was sent but doesn't verify → tampering/expiry, not a direct install.
    if (stateRaw && !state) {
      settingsUrl.searchParams.set("gh_error", "install_expired")
      return c.redirect(settingsUrl.toString())
    }
    // Signed state binds the workspace; absent state → the session's workspace.
    const org = state?.org ?? (await activeWorkspace(c).catch(() => null))
    const uid = state?.uid ?? (await currentUser(c).catch(() => null))?.id ?? "github"
    if (!org) {
      settingsUrl.searchParams.set("gh_error", "install_failed")
      return c.redirect(settingsUrl.toString())
    }
    // Record the installation against the workspace. Account login is filled in
    // by the repo list / webhook later.
    await meta.upsertGithubInstallation({
      installation_id: installationId,
      org_id: org,
      account_login: null,
      created_by: uid,
      created_at: new Date().toISOString(),
    })
    // Land back on the repo picker for this fresh installation.
    settingsUrl.searchParams.set("gh_install", installationId)
    return c.redirect(settingsUrl.toString())
  })

  // ---- Repos an installation can mirror (drives the picker) -------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/sync/github/installations/{id}/repos",
      tags: ["Sync"],
      summary: "The repos an installation can mirror (Admin only).",
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "The installation's repos, most-recent-push first.",
          content: {
            "application/json": { schema: z.object({ repos: z.array(InstallationRepo) }) },
          },
        },
      },
    }),
    async (c) => {
      if (!(await workspaceCan(c, "publish"))) return bail(fail(c, 403, "forbidden"))
      const org = await activeWorkspace(c)
      const installationId = c.req.param("id")
      const inst = await meta.getGithubInstallation(installationId)
      // Scope: only an installation owned by the caller's workspace is listable.
      if (!inst || inst.org_id !== org) return bail(fail(c, 404, "not found"))
      const loaded = await loadApp()
      if (!loaded) return bail(fail(c, 409, "GitHub App is not set up yet"))
      try {
        const token = await installationToken(loaded.app.app_id, loaded.pem, installationId)
        const repos = await listInstallationRepos(token)
        return c.json({ repos })
      } catch (err) {
        const userError = err instanceof GitHubError && err.status < 500
        return bail(
          fail(c, userError ? 400 : 502, err instanceof Error ? err.message : "listing failed"),
        )
      }
    },
  )

  // ---- Preview: how many docs a repo+scope would mirror -----------------
  // Lists the tree (no blob fetches) and counts matching files by type, so the
  // picker can show "~396 files · 360 MD · 36 HTML" before you commit + scope.
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/sync/github/installations/{id}/preview",
      tags: ["Sync"],
      summary: "How many docs a repo + scope would mirror (Admin only).",
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "Matching file counts by type + whether the tree was truncated.",
          content: { "application/json": { schema: SyncPreview } },
        },
      },
    }),
    async (c) => {
      if (!(await workspaceCan(c, "publish"))) return bail(fail(c, 403, "forbidden"))
      const org = await activeWorkspace(c)
      const installationId = c.req.param("id")
      const inst = await meta.getGithubInstallation(installationId)
      if (!inst || inst.org_id !== org) return bail(fail(c, 404, "not found"))
      const parsed = parseRepo(c.req.query("repo") ?? "")
      if (!parsed) return bail(fail(c, 400, "repo must be owner/name"))
      const globs = (c.req.query("includes")?.trim() || DEFAULT_INCLUDES)
        .split(",")
        .map((g) => g.trim())
        .filter(Boolean)
      const loaded = await loadApp()
      if (!loaded) return bail(fail(c, 409, "GitHub App is not set up yet"))
      try {
        const token = await installationToken(loaded.app.app_id, loaded.pem, installationId)
        const { entries, truncated } = await listTree(
          parsed,
          c.req.query("ref")?.trim() || "HEAD",
          token,
        )
        const matched = entries.filter((e) => matchesGlobs(e.path, globs))
        const md = matched.filter((e) => /\.(md|markdown)$/i.test(e.path)).length
        const html = matched.filter((e) => /\.html?$/i.test(e.path)).length
        return c.json({
          total: matched.length,
          md,
          html,
          other: matched.length - md - html,
          truncated,
        })
      } catch (err) {
        const userError = err instanceof GitHubError && err.status < 500
        return bail(
          fail(c, userError ? 400 : 502, err instanceof Error ? err.message : "preview failed"),
        )
      }
    },
  )

  // ---- Connect a repo (App installation OR a PAT) -----------------------
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/sync/github",
      tags: ["Sync"],
      summary: "Connect a repo for mirroring (App installation or a PAT).",
      responses: {
        200: {
          description: "The existing source (this repo was already connected).",
          content: { "application/json": { schema: RepoSource } },
        },
        201: {
          description: "The newly connected source (first sync kicked off).",
          content: { "application/json": { schema: RepoSource } },
        },
      },
    }),
    async (c) => {
      if (!(await workspaceCan(c, "publish"))) return bail(fail(c, 403, "forbidden"))
      const body = await readJson(
        c,
        z.object({
          repo: z.string(),
          ref: z.string().optional(),
          includes: z.string().optional(),
          token: z.string().optional(),
          installation_id: z.string().optional(),
        }),
      )
      if (body instanceof Response) return bail(body)
      const parsed = parseRepo(body.repo)
      if (!parsed) return bail(fail(c, 400, "repo must be owner/name"))
      const repo = `${parsed.owner}/${parsed.name}`
      const org = await activeWorkspace(c)
      const createdBy = (await currentUser(c))?.id ?? "anon"

      // Dedup: one BRANCH source (and one collection) per repo in a workspace.
      // Re-connecting an already-connected repo returns the existing source instead of
      // spawning a duplicate collection — the bug that produced two "GitHub: <repo>"
      // collections. PR previews (`pr_number` set) are excluded — they're per-PR, not
      // the repo's canonical mirror.
      const existing = (await meta.listRepoSources(org)).find(
        (s) => s.repo === repo && s.pr_number == null,
      )
      if (existing) return c.json(toJson(existing))

      // An installation-backed source: validate the installation belongs to this
      // workspace so a source can't be pinned to someone else's install.
      let installationId: string | null = null
      if (body.installation_id) {
        const inst = await meta.getGithubInstallation(body.installation_id)
        if (!inst || inst.org_id !== org) return bail(fail(c, 400, "unknown installation"))
        installationId = body.installation_id
      }

      // One collection per repo, created up front so the first sync has a home.
      const col = await meta.createCollection({
        id: newId("col"),
        org_id: org,
        title: `GitHub: ${repo}`,
        created_by: createdBy,
      })
      await meta.setCollectionMember({
        id: newId("cm"),
        collection_id: col.id,
        user_id: createdBy,
        role: "owner",
      })
      // Encrypt a PAT at rest when one is given and a server key is configured;
      // never store or return it in the clear. Installation-backed sources carry no
      // token (they mint short-lived ones at sync time).
      const raw = installationId ? undefined : body.token?.trim()
      const token = raw ? (deps.encryptionKey ? encryptSecret(raw, deps.encryptionKey) : raw) : null
      const source = await meta.createRepoSource({
        id: newId("rs"),
        org_id: org,
        collection_id: col.id,
        repo,
        ref: body.ref?.trim() || "HEAD",
        includes: body.includes?.trim() || DEFAULT_INCLUDES,
        token,
        installation_id: installationId,
        created_by: createdBy,
      })
      // Kick the first sync server-side right away, so connecting a repo immediately
      // shows the live bar (no separate "Sync now" needed). No inline fallback here —
      // a no-runner env starts mirroring on the explicit /run instead.
      await launch(source, false)
      const fresh = (await meta.getRepoSource(source.id, org)) ?? source
      return c.json(toJson(fresh), 201)
    },
  )

  // ---- Manual "Sync now" ------------------------------------------------
  // Triggers a server-side sync and returns at once (202) — the work runs on our
  // servers (DO / Node loop), so the user can close the tab. The UI polls /status for
  // the live bar. Without a runner wired (tests/dev), runs inline to completion and
  // returns the finished source instead, so a self-host still mirrors synchronously.
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/sync/github/{id}/run",
      tags: ["Sync"],
      summary: "Trigger a server-side sync (Admin only).",
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "The finished source (ran inline; no runner wired).",
          content: { "application/json": { schema: RepoSource } },
        },
        202: {
          description: "The source, queued (sync runs on the server; poll /status).",
          content: { "application/json": { schema: RepoSource } },
        },
      },
    }),
    async (c) => {
      if (!(await workspaceCan(c, "publish"))) return bail(fail(c, 403, "forbidden"))
      const org = await activeWorkspace(c)
      const source = await meta.getRepoSource(c.req.param("id"), org)
      if (!source) return bail(fail(c, 404, "not found"))
      if (deps.maxArtifacts && (await meta.countArtifacts(org)) >= deps.maxArtifacts)
        return bail(fail(c, 409, "artifact quota reached"))
      if (deps.startSync) {
        await launch(source, false)
        const fresh = (await meta.getRepoSource(source.id, org)) ?? source
        return c.json(toJson(fresh), 202)
      }
      try {
        // A GitHub <500 is a bad repo/token/install (the caller's to fix → 400); else 502.
        await meta.setRepoSourceProgress(source.id, queuedProgress(new Date().toISOString()))
        await runToCompletion(meta, deps.blobs, deps.encryptionKey, source.id)
      } catch (err) {
        const userError = err instanceof GitHubError && err.status < 500
        return bail(
          fail(c, userError ? 400 : 502, err instanceof Error ? err.message : "sync failed"),
        )
      }
      const fresh = (await meta.getRepoSource(source.id, org)) ?? source
      return c.json(toJson(fresh))
    },
  )

  // ---- Status poll (drives the big progress bar) ------------------------
  // Deliberately cheap: no GitHub round-trip (unlike the list endpoint's appIsLive
  // check), just the persisted progress + status + count — so the UI polls it every
  // ~1.5s while a sync runs without hammering GitHub.
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/sync/github/{id}/status",
      tags: ["Sync"],
      summary: "Cheap status poll for a source's live progress bar.",
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "The source's persisted progress + last status + file count.",
          content: { "application/json": { schema: SyncStatus } },
        },
      },
    }),
    async (c) => {
      if (!(await workspaceCan(c, "comment"))) return bail(fail(c, 403, "forbidden"))
      const org = await activeWorkspace(c)
      const source = await meta.getRepoSource(c.req.param("id"), org)
      if (!source) return bail(fail(c, 404, "not found"))
      const view = toJson(source)
      return c.json({
        id: source.id,
        repo: source.repo,
        progress: view.progress ?? null,
        last_status: source.last_status,
        last_synced_at: source.last_synced_at,
        file_count: view.file_count,
      })
    },
  )

  // ---- Active syncs in this workspace (drives the global chip) ----------
  // Every source mid-sync (progress phase queued/listing/mirroring), so the app-shell
  // chip can show "Syncing <repo> · 47/190" from any page. Static path, so it never
  // collides with the `:id` routes above.
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/sync/github/active",
      tags: ["Sync"],
      summary: "Sources mid-sync in this workspace (drives the global syncing chip).",
      responses: {
        200: {
          description: "The sources currently syncing.",
          content: { "application/json": { schema: z.object({ active: z.array(RepoSource) }) } },
        },
      },
    }),
    async (c) => {
      if (!(await workspaceCan(c, "comment"))) return bail(fail(c, 403, "forbidden"))
      const org = await activeWorkspace(c)
      const active = (await meta.listRepoSources(org)).filter(isSyncing).map(toJson)
      return c.json({ active })
    },
  )

  // ---- Disconnect -------------------------------------------------------
  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/sync/github/{id}",
      tags: ["Sync"],
      summary: "Disconnect a source (?wipe=true also deletes its artifacts).",
      request: { params: z.object({ id: z.string() }) },
      responses: { 204: { description: "The source was disconnected." } },
    }),
    async (c) => {
      if (!(await workspaceCan(c, "publish"))) return bail(fail(c, 403, "forbidden"))
      const org = await activeWorkspace(c)
      const source = await meta.getRepoSource(c.req.param("id"), org)
      if (!source) return bail(fail(c, 404, "not found"))
      if (c.req.query("wipe") === "true") {
        // Delete every artifact this source manages, then its collection.
        try {
          const map = JSON.parse(source.files || "{}") as Record<string, { artifact_id?: string }>
          for (const entry of Object.values(map)) {
            if (entry.artifact_id) await meta.deleteArtifact(entry.artifact_id, org)
          }
        } catch {
          /* malformed files map — skip */
        }
        await meta.deleteCollection(source.collection_id)
      }
      // Default: keep the collection + artifacts so the docs stay readable.
      await meta.deleteRepoSource(source.id, org)
      return c.body(null, 204)
    },
  )

  // ---- Webhook (push auto-sync + install lifecycle) ---------------------
  // GitHub posts here (no session), so it's allow-listed past the anonymous
  // lockdown and authenticated instead by the App's webhook secret over the raw
  // body. A push to a tracked repo/branch re-mirrors it; install events keep the
  // connection state honest. Plain route: a GitHub server-to-server callback.
  // authz-exempt: GitHub server-to-server callback — the App webhook-secret HMAC over the raw body is the gate, not a session.
  app.post("/v1/sync/github/webhook", async (c) => {
    const loaded = await loadApp()
    if (!loaded) return fail(c, 404, "GitHub App is not set up")
    const raw = await c.req.text()
    if (!verifyWebhookSignature(raw, c.req.header("x-hub-signature-256"), loaded.webhookSecret))
      return fail(c, 401, "bad signature")

    const event = c.req.header("x-github-event") ?? ""
    let payload: GitHubWebhookPayload
    try {
      payload = JSON.parse(raw) as GitHubWebhookPayload
    } catch {
      return fail(c, 400, "invalid payload")
    }

    if (event === "push") {
      const installationId = payload.installation?.id ? String(payload.installation.id) : null
      const fullName = payload.repository?.full_name
      const branch = payload.ref?.replace(/^refs\/heads\//, "")
      const defaultBranch = payload.repository?.default_branch
      if (installationId && fullName && branch) {
        const sources = await meta.listRepoSourcesByInstallation(installationId)
        // BRANCH sources only (`pr_number == null`). PR previews are driven by the
        // `pull_request` event below — a same-repo branch push must not double-trigger
        // them (and a PR preview's `ref` is a head sha, not a branch name, anyway).
        const matched = sources.filter(
          (s) =>
            s.pr_number == null &&
            s.repo.toLowerCase() === fullName.toLowerCase() &&
            (s.ref === branch || (s.ref === "HEAD" && branch === defaultBranch)),
        )
        // Re-sync each match on the server (DO / Node loop), same as a manual run —
        // so a push mirrors tab-independently and the bar shows up if anyone's looking.
        // Progress + failures are persisted per-source by the engine.
        for (const s of matched) await launch(s, true)
        if (matched.length) log.info("push auto-sync queued", { repo: fullName, n: matched.length })
      }
    } else if (event === "pull_request") {
      // PR PREVIEWS. Only repos already connected for branch sync get one — the branch
      // source (the one with no `pr_number`) binds the preview to a workspace and the
      // include globs. Open/reopen/synchronize → mirror the PR's changed docs at the
      // head; close/merge → tear the preview down.
      const installationId = payload.installation?.id ? String(payload.installation.id) : null
      const fullName = payload.repository?.full_name
      const prNumber = payload.pull_request?.number
      const action = payload.action
      if (installationId && fullName && prNumber) {
        const sources = await meta.listRepoSourcesByInstallation(installationId)
        const lc = fullName.toLowerCase()
        const branch = sources.find((s) => s.pr_number == null && s.repo.toLowerCase() === lc)
        const preview = sources.find((s) => s.pr_number === prNumber && s.repo.toLowerCase() === lc)
        if (branch) {
          if (action === "closed") {
            // MERGED → graduate the preview into the canonical collection (docs live on
            // with their comments + the PR's versions in history). CLOSED-without-merge →
            // just tear it down (nothing landed). A dropped `closed` delivery would orphan
            // a preview; it's removable from the UI today (DELETE /v1/sync/github/:id) —
            // an automated reconciler is a noted follow-up.
            const merged = !!payload.pull_request?.merged
            if (preview) {
              // Resolve the sticky comment to its final state before tearing the
              // preview down (best-effort, same toggle as the open path).
              if ((await meta.getOrgSettings(branch.org_id)).githubPreviewLink) {
                const parsed = parseRepo(fullName)
                if (parsed) {
                  try {
                    const token = await effectiveToken(meta, deps.encryptionKey, branch)
                    const link = `${deps.baseUrl.replace(/\/$/, "")}/?collection=${branch.collection_id}`
                    const body = merged
                      ? `✅ **Merged.** These docs are now part of [${branch.repo} in Derive](${link}).`
                      : "📦 **Derive preview** removed (this PR was closed without merging)."
                    if (token) await upsertPreviewComment(parsed, prNumber, body, token)
                  } catch (err) {
                    log.warn("pr preview comment (close) skipped", {
                      repo: fullName,
                      pr: prNumber,
                      error: err instanceof Error ? err.message : String(err),
                    })
                  }
                }
              }
              await (merged ? graduatePreview(preview) : removePrPreview(preview))
            }
            log.info("pr preview closed", { repo: fullName, pr: prNumber, merged })
          } else if (action === "opened" || action === "reopened" || action === "synchronize") {
            const headSha = payload.pull_request?.head?.sha
            const parsed = parseRepo(fullName)
            if (headSha && parsed) {
              // Mirror only the PR's changed DOCS (changed files ∩ the branch source's
              // include globs). No matching docs → no preview (and clean up one that
              // emptied out). Best-effort: a GitHub hiccup just skips this delivery;
              // the next `synchronize` retries.
              try {
                const token = await effectiveToken(meta, deps.encryptionKey, branch)
                const globs = branch.includes
                  .split(",")
                  .map((g) => g.trim())
                  .filter(Boolean)
                const changedDocs = (await listPullFiles(parsed, prNumber, token)).filter((p) =>
                  matchesGlobs(p, globs),
                )
                if (changedDocs.length === 0) {
                  if (preview) await removePrPreview(preview)
                } else {
                  const { collectionId } = await upsertPrPreview(
                    branch,
                    preview,
                    prNumber,
                    payload.pull_request?.title ?? "",
                    headSha,
                  )
                  log.info("pr preview queued", {
                    repo: fullName,
                    pr: prNumber,
                    docs: changedDocs.length,
                  })
                  // Sticky preview comment on the PR (best-effort, workspace-toggleable).
                  if (token && (await meta.getOrgSettings(branch.org_id)).githubPreviewLink) {
                    try {
                      await upsertPreviewComment(
                        parsed,
                        prNumber,
                        previewCommentBody(collectionId, changedDocs.length),
                        token,
                      )
                    } catch (err) {
                      log.warn("pr preview comment skipped", {
                        repo: fullName,
                        pr: prNumber,
                        error: err instanceof Error ? err.message : String(err),
                      })
                    }
                  }
                }
              } catch (err) {
                log.warn("pr preview skipped", {
                  repo: fullName,
                  pr: prNumber,
                  error: err instanceof Error ? err.message : String(err),
                })
              }
            }
          }
        }
      }
    } else if (event === "issue_comment" || event === "pull_request_review_comment") {
      // Mirror a PR comment made on GitHub back into the Derive artifact (the inbound half
      // of bidirectional comment sync). Only `created`; only for PRs that Derive previews.
      const installationId = payload.installation?.id ? String(payload.installation.id) : null
      const fullName = payload.repository?.full_name
      const prNumber =
        event === "issue_comment" ? payload.issue?.number : payload.pull_request?.number
      const isPr = event === "pull_request_review_comment" || !!payload.issue?.pull_request
      const cmt = payload.comment
      if (
        payload.action === "created" &&
        installationId &&
        fullName &&
        prNumber &&
        isPr &&
        cmt?.id &&
        cmt.body
      ) {
        const lc = fullName.toLowerCase()
        const preview = (await meta.listRepoSourcesByInstallation(installationId)).find(
          (s) => s.pr_number === prNumber && s.repo.toLowerCase() === lc,
        )
        // Respect the workspace toggle; skip silently when the PR isn't mirrored in Derive.
        if (preview && (await meta.getOrgSettings(preview.org_id)).githubMirrorComments) {
          const created = await ingestGithubPrComment(meta, preview, {
            ghCommentId: cmt.id,
            kind: event === "pull_request_review_comment" ? "review" : "issue",
            authorLogin: cmt.user?.login ?? "github",
            authorType: cmt.user?.type,
            body: cmt.body,
            path: cmt.path,
            diffHunk: cmt.diff_hunk,
          })
          // Signal-only realtime nudge: open viewers refetch the (account-gated) comments.
          if (created) bus.publish(created.artifact_id, { type: "comment.created" })
        }
      }
    } else if (event === "installation") {
      const installationId = payload.installation?.id ? String(payload.installation.id) : null
      if (payload.action === "deleted") {
        // Uninstalled: drop our row. Synced docs stay (same as manual disconnect).
        if (installationId) await meta.deleteGithubInstallation(installationId)
      } else if (
        (payload.action === "created" || payload.action === "new_permissions_accepted") &&
        installationId
      ) {
        // New installation or permission upgrade: record/update the row. We don't know
        // which Derive workspace to assign it to from the webhook alone, so we upsert
        // against any existing row (re-using its org_id) or create under a sentinel
        // org so the next `resync-installations` call from the UI can claim it.
        const existing = await meta.getGithubInstallation(installationId)
        await meta.upsertGithubInstallation({
          installation_id: installationId,
          org_id: existing?.org_id ?? "pending",
          account_login: payload.installation?.account?.login ?? null,
          created_by: "webhook",
          created_at: new Date().toISOString(),
        })
      }
    }
    // installation_repositories (repos added/removed) needs no action here: a
    // removed repo's source just errors on its next sync, and an added repo is
    // connected explicitly through the picker.

    return c.json({ ok: true })
  })

  return app
}
