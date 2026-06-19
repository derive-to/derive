import type { GitHubAppRecord, RepoSourceRecord, SyncProgress, VersionRecord } from "@dock/core"
import { newId } from "@dock/core"
import { Hono } from "hono"
import { z } from "zod"
import type { AppContext } from "../context"
import { sweepAnchors } from "../lib/anchor-sweep"
import { decryptSecret, encryptSecret, signState, verifyState } from "../lib/crypto"
import { GitHubError, listPullFiles, listTree, matchesGlobs, parseRepo } from "../lib/github"
import {
  getAppInfo,
  installationToken,
  listInstallationRepos,
  patchAppPermissions,
  verifyWebhookSignature,
} from "../lib/github-app"
import { fail, readJson } from "../lib/http"
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
  installation?: { id?: number }
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
}

/**
 * Sync from GitHub: mirror a repo's Markdown/HTML into a collection, one-way.
 * Two ways in — a GitHub App (install → pick repos → push auto-sync, no stored
 * secret) or a pasted read-only PAT (self-host without an App). Synced artifacts
 * are read-only (the gate lives in the publish/propose routes); this manages the
 * connection, the App install handshake, and drives the engine (lib/sync).
 */
export const syncRoutes = (ctx: AppContext) => {
  const { meta, deps, currentUser, activeWorkspace, workspaceCan, background } = ctx
  const app = new Hono()

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

  // Is the stored App still live on GitHub? An App the owner deleted on GitHub
  // leaves a stale row here, which would strand the UI on "Install" pointing at a
  // dead slug with no way back. We verify against GitHub (GET /app) and cache the
  // verdict ~5min per isolate so this isn't a per-request call. On success we also
  // self-heal the slug if it drifted (the App was renamed). A network blip is
  // treated as "live" (fail-open) so a transient error never hides a good App.
  const appLiveCache = new Map<string, { ok: boolean; at: number }>()
  const appIsLive = async (loaded: { app: GitHubAppRecord; pem: string }): Promise<boolean> => {
    const cached = appLiveCache.get(loaded.app.app_id)
    if (cached && Date.now() - cached.at < 5 * 60_000) return cached.ok
    try {
      const info = await getAppInfo(loaded.app.app_id, loaded.pem)
      if (info.slug && info.slug !== loaded.app.slug)
        await meta.setGithubApp({ ...loaded.app, slug: info.slug })
      appLiveCache.set(loaded.app.app_id, { ok: true, at: Date.now() })
      return true
    } catch (err) {
      // 404/401 → deleted or revoked: definitively dead. Anything else (network,
      // 5xx) → keep trusting the stored App rather than hide a working setup.
      const dead = err instanceof GitHubError && (err.status === 404 || err.status === 401)
      if (!dead) return true
      appLiveCache.set(loaded.app.app_id, { ok: false, at: Date.now() })
      return false
    }
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

  // ---- PR previews ------------------------------------------------------
  // A PR preview is an ephemeral, READ-ONLY repo_source (`pr_number` set, `ref` = the
  // PR head sha) into its own collection ("PR #<n>: <title>"). It inherits the branch
  // source's installation + include globs, and the engine scopes the mirror to just the
  // PR's changed docs (off `pr_number`). Created on open/synchronize, torn down on close.
  // Upsert a preview to the PR's current head. An existing preview is re-pointed at the
  // new head sha (its file map is kept, so the engine updates artifacts in place and
  // tombstones docs the PR no longer touches); a missing one is created fresh.
  const upsertPrPreview = async (
    branch: RepoSourceRecord,
    existing: RepoSourceRecord | undefined,
    prNumber: number,
    prTitle: string,
    headSha: string,
  ): Promise<void> => {
    const title = `PR #${prNumber}: ${prTitle.trim() || "(untitled)"}`.slice(0, 200)
    if (existing) {
      await meta.updateRepoSourceSync(existing.id, { ref: headSha })
      await meta.updateCollection(existing.collection_id, { title })
      await launch(existing, true)
      return
    }
    const col = await meta.createCollection({
      id: newId("col"),
      org_id: branch.org_id,
      title,
      created_by: branch.created_by,
    })
    await meta.setCollectionMember({
      id: newId("cm"),
      collection_id: col.id,
      user_id: branch.created_by,
      role: "owner",
    })
    const source = await meta.createRepoSource({
      id: newId("rs"),
      org_id: branch.org_id,
      collection_id: col.id,
      repo: branch.repo,
      ref: headSha,
      includes: branch.includes,
      token: null,
      installation_id: branch.installation_id,
      pr_number: prNumber,
      created_by: branch.created_by,
    })
    await launch(source, true)
  }

  // Tear down a preview WITHOUT graduating it: tombstone its artifacts, drop the source
  // + collection. Used when a PR is CLOSED-without-merge (nothing landed) or stops
  // changing any docs. A MERGED PR goes through graduatePreview instead.
  const removePrPreview = async (preview: RepoSourceRecord): Promise<void> => {
    let artifactIds: string[] = []
    try {
      const map = JSON.parse(preview.files || "{}") as Record<string, { artifact_id?: string }>
      artifactIds = Object.values(map)
        .map((f) => f?.artifact_id)
        .filter((id): id is string => !!id)
    } catch {
      // A malformed map → nothing to tombstone; still drop the source + collection.
    }
    const removedAt = new Date().toISOString()
    for (const id of artifactIds) await meta.setArtifactRemoved(id, removedAt)
    await meta.deleteRepoSource(preview.id, preview.org_id)
    await meta.deleteCollection(preview.collection_id)
  }

  type PreviewFile = { artifact_id?: string } & Record<string, unknown>
  const parseFileMap = (s: string): Record<string, PreviewFile> => {
    try {
      return JSON.parse(s || "{}") as Record<string, PreviewFile>
    } catch {
      return {}
    }
  }

  // Fold a preview artifact into the canonical doc that already exists for its path,
  // then delete the preview copy. The PR's versions APPEND onto the canonical (blob keys
  // are content-addressed, so this is cheap and addVersion bumps current_version), so
  // they become part of its history. Comment threads are re-cloned onto the canonical
  // with fresh ids (preserving the root==thread_id invariant + the thread state) and
  // re-anchored against the new current version, so review carries over.
  const foldIntoCanonical = async (
    preview: RepoSourceRecord,
    previewId: string,
    canonicalId: string,
  ): Promise<void> => {
    const prefix = `PR #${preview.pr_number}`
    let latest: VersionRecord | null = null
    for (const v of await meta.listVersions(previewId)) {
      latest = await meta.addVersion(canonicalId, {
        id: newId("ver"),
        blob_key: v.blob_key,
        content_type: v.content_type,
        size_bytes: v.size_bytes,
        author: v.author,
        author_login: v.author_login,
        author_avatar: v.author_avatar,
        author_gh_id: v.author_gh_id,
        message: v.message ? `${prefix}: ${v.message}` : prefix,
        name: v.name,
      })
    }
    const comments = await meta.listComments(previewId)
    const threads = new Map<string, typeof comments>()
    for (const cm of comments) {
      const arr = threads.get(cm.thread_id)
      if (arr) arr.push(cm)
      else threads.set(cm.thread_id, [cm])
    }
    const baseVersion = latest?.n ?? 1
    for (const group of threads.values()) {
      const root = group.find((c) => c.id === c.thread_id) ?? group[0]
      if (!root) continue
      const newThreadId = newId("cmt")
      for (const cm of [root, ...group.filter((c) => c !== root)]) {
        await meta.createComment({
          id: cm === root ? newThreadId : newId("cmt"),
          artifact_id: canonicalId,
          thread_id: newThreadId,
          base_version: baseVersion,
          path: cm.path,
          anchor: cm.anchor,
          body_md: cm.body_md,
          author: cm.author,
          author_id: cm.author_id,
        })
      }
      if (root.state !== "open") await meta.setThreadState(canonicalId, newThreadId, root.state)
    }
    // Re-anchor the canonical doc's threads (incl. the migrated ones) against its new
    // current version — quoted text that survived the merge stays anchored, the rest flips
    // to `outdated` (Dock's normal post-version-bump behavior).
    if (latest) await sweepAnchors(meta, deps.blobs, canonicalId, latest)
    // The preview copy is now redundant — hard-delete it (cascades its versions + comments).
    await meta.deleteArtifact(previewId, preview.org_id)
  }

  // On MERGE, GRADUATE the preview into the canonical collection instead of dropping it:
  // the docs you reviewed live on in "GitHub: <repo>" with their comments + the PR's
  // versions folded into history. Per path the preview owns: a doc the main mirror
  // doesn't track yet (the PR ADDS it) is PROMOTED — re-homed into the main collection and
  // handed to the branch source, keeping its artifact + versions + comments; a doc the
  // main mirror already owns (the PR EDITS it) is FOLDED into that canonical artifact.
  // Best-effort per path: one bad path is logged + skipped, never aborting the rest.
  const graduatePreview = async (preview: RepoSourceRecord): Promise<void> => {
    const branch = (await meta.listRepoSourcesByInstallation(preview.installation_id ?? "")).find(
      (s) => s.pr_number == null && s.repo.toLowerCase() === preview.repo.toLowerCase(),
    )
    // The branch mirror was disconnected mid-PR — nothing to graduate into; just tear down.
    if (!branch) return removePrPreview(preview)

    const previewMap = parseFileMap(preview.files)
    // Re-read the branch source for the freshest file map — the merge-commit push may be
    // syncing it concurrently; read-modify-write shrinks (not eliminates) that window.
    const freshBranch = (await meta.getRepoSource(branch.id, branch.org_id)) ?? branch
    const branchMap = parseFileMap(freshBranch.files)

    for (const [path, pf] of Object.entries(previewMap)) {
      if (!pf.artifact_id) continue
      try {
        const canonicalId = branchMap[path]?.artifact_id
        if (canonicalId && canonicalId !== pf.artifact_id) {
          await foldIntoCanonical(preview, pf.artifact_id, canonicalId)
          // The canonical doc now carries the merged content; mark the path current (with
          // the PR head sha) so the merge-push sync sees no change and skips it.
          branchMap[path] = { ...branchMap[path], ...pf }
        } else {
          // PROMOTE: re-home the artifact into the main collection + transfer ownership.
          await meta.removeCollectionItem(preview.collection_id, pf.artifact_id)
          await meta.addCollectionItem(branch.collection_id, pf.artifact_id)
          await meta.setArtifactSourcePath(pf.artifact_id, path)
          branchMap[path] = pf
        }
      } catch (err) {
        log.warn("pr graduate path skipped", {
          repo: preview.repo,
          pr: preview.pr_number,
          path,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    await meta.updateRepoSourceSync(branch.id, { files: JSON.stringify(branchMap) })
    // Drop the preview shell. Folded artifacts are already deleted; promoted ones were
    // moved out of this collection, so deleting it leaves the graduated docs untouched.
    await meta.deleteRepoSource(preview.id, preview.org_id)
    await meta.deleteCollection(preview.collection_id)
  }

  // ---- List + connection status -----------------------------------------
  app.get("/v1/sync/github", async (c) => {
    if (!(await workspaceCan(c, "comment"))) return fail(c, 403, "forbidden")
    const org = await activeWorkspace(c)
    const [sources, installs, loaded] = await Promise.all([
      meta.listRepoSources(org),
      meta.listGithubInstallations(org),
      loadApp(),
    ])
    // A configured App that GitHub no longer knows about (deleted) reports as
    // unconfigured, so the UI shows "Set up" again instead of a dead Install link.
    const live = loaded ? await appIsLive(loaded) : false
    // Split branch mirrors from PR previews — the UI lists them in separate groups.
    // A preview carries its PR number; its collection title ("PR #<n>: <title>") names it.
    const branchSources = sources.filter((s) => s.pr_number == null)
    const previews = sources.filter((s) => s.pr_number != null)
    const previewCols = await Promise.all(previews.map((s) => meta.getCollection(s.collection_id)))
    return c.json({
      sources: branchSources.map(toJson),
      prs: previews.map((s, i) => ({
        ...toJson(s),
        pr_number: s.pr_number,
        title: previewCols[i]?.title ?? `PR #${s.pr_number}`,
      })),
      // What the UI needs to pick its entry point: is a live App set up (→ Connect
      // button + slug for the install link), and which installations this
      // workspace already has (→ jump straight to the repo picker).
      app: loaded && live ? { configured: true, slug: loaded.app.slug } : { configured: false },
      installations: installs.map((i) => ({
        installation_id: i.installation_id,
        account_login: i.account_login,
      })),
    })
  })

  // ---- Update App permissions in-place ---------------------------------
  // Patches the stored App's permissions + events via GitHub's PATCH /app so
  // installers get a "Accept new permissions" prompt on GitHub without needing
  // to delete + recreate the App. Idempotent: safe to call even when already
  // up to date (GitHub ignores no-ops).
  app.post("/v1/sync/github/app/patch-permissions", async (c) => {
    if (!(await workspaceCan(c, "publish"))) return fail(c, 403, "forbidden")
    const loaded = await loadApp()
    if (!loaded) return fail(c, 409, "GitHub App is not set up yet")
    try {
      await patchAppPermissions(
        loaded.app.app_id,
        loaded.pem,
        { contents: "read", metadata: "read", pull_requests: "read" },
        ["push", "pull_request"],
      )
      return c.json({ ok: true })
    } catch (err) {
      return fail(c, 502, err instanceof Error ? err.message : "patch failed")
    }
  })

  // ---- App install: hand back the GitHub install URL --------------------
  // The SPA navigates the browser to this URL; GitHub walks the user through
  // picking repos, then redirects to /v1/sync/github/callback with our state.
  app.post("/v1/sync/github/install", async (c) => {
    if (!(await workspaceCan(c, "publish"))) return fail(c, 403, "forbidden")
    const loaded = await loadApp()
    if (!loaded) return fail(c, 409, "GitHub App is not set up yet")
    const org = await activeWorkspace(c)
    const uid = (await currentUser(c))?.id ?? "anon"
    const state = signState({ org, uid }, deps.encryptionKey as string)
    const url = `https://github.com/apps/${encodeURIComponent(
      loaded.app.slug,
    )}/installations/new?state=${encodeURIComponent(state)}`
    return c.json({ url })
  })

  // ---- App install callback (GitHub → browser redirect) -----------------
  // GET, so it passes the anonymous-write lockdown; the binding to a workspace
  // comes from the signed state, never the session, so it can't be replayed into
  // someone else's workspace.
  app.get("/v1/sync/github/callback", async (c) => {
    const installationId = c.req.query("installation_id")
    const stateRaw = c.req.query("state") ?? ""
    const settingsUrl = new URL("/settings?tab=github", deps.baseUrl)
    if (!deps.encryptionKey || !installationId) {
      settingsUrl.searchParams.set("gh_error", "install_failed")
      return c.redirect(settingsUrl.toString())
    }
    const state = verifyState<InstallState>(stateRaw, deps.encryptionKey)
    if (!state) {
      settingsUrl.searchParams.set("gh_error", "install_expired")
      return c.redirect(settingsUrl.toString())
    }
    // Record the installation against the workspace that started the flow. The
    // account login is best-effort (filled in by the repo list / webhook later).
    await meta.upsertGithubInstallation({
      installation_id: installationId,
      org_id: state.org,
      account_login: null,
      created_by: state.uid,
      created_at: new Date().toISOString(),
    })
    // Land back on the repo picker for this fresh installation.
    settingsUrl.searchParams.set("gh_install", installationId)
    return c.redirect(settingsUrl.toString())
  })

  // ---- Repos an installation can mirror (drives the picker) -------------
  app.get("/v1/sync/github/installations/:id/repos", async (c) => {
    if (!(await workspaceCan(c, "publish"))) return fail(c, 403, "forbidden")
    const org = await activeWorkspace(c)
    const installationId = c.req.param("id")
    const inst = await meta.getGithubInstallation(installationId)
    // Scope: only an installation owned by the caller's workspace is listable.
    if (!inst || inst.org_id !== org) return fail(c, 404, "not found")
    const loaded = await loadApp()
    if (!loaded) return fail(c, 409, "GitHub App is not set up yet")
    try {
      const token = await installationToken(loaded.app.app_id, loaded.pem, installationId)
      const repos = await listInstallationRepos(token)
      return c.json({ repos })
    } catch (err) {
      const userError = err instanceof GitHubError && err.status < 500
      return fail(c, userError ? 400 : 502, err instanceof Error ? err.message : "listing failed")
    }
  })

  // ---- Preview: how many docs a repo+scope would mirror -----------------
  // Lists the tree (no blob fetches) and counts matching files by type, so the
  // picker can show "~396 files · 360 MD · 36 HTML" before you commit + scope.
  app.get("/v1/sync/github/installations/:id/preview", async (c) => {
    if (!(await workspaceCan(c, "publish"))) return fail(c, 403, "forbidden")
    const org = await activeWorkspace(c)
    const installationId = c.req.param("id")
    const inst = await meta.getGithubInstallation(installationId)
    if (!inst || inst.org_id !== org) return fail(c, 404, "not found")
    const parsed = parseRepo(c.req.query("repo") ?? "")
    if (!parsed) return fail(c, 400, "repo must be owner/name")
    const globs = (c.req.query("includes")?.trim() || DEFAULT_INCLUDES)
      .split(",")
      .map((g) => g.trim())
      .filter(Boolean)
    const loaded = await loadApp()
    if (!loaded) return fail(c, 409, "GitHub App is not set up yet")
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
      return fail(c, userError ? 400 : 502, err instanceof Error ? err.message : "preview failed")
    }
  })

  // ---- Connect a repo (App installation OR a PAT) -----------------------
  app.post("/v1/sync/github", async (c) => {
    if (!(await workspaceCan(c, "publish"))) return fail(c, 403, "forbidden")
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
    if (body instanceof Response) return body
    const parsed = parseRepo(body.repo)
    if (!parsed) return fail(c, 400, "repo must be owner/name")
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
      if (!inst || inst.org_id !== org) return fail(c, 400, "unknown installation")
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
  })

  // ---- Manual "Sync now" ------------------------------------------------
  // Triggers a server-side sync and returns at once (202) — the work runs on our
  // servers (DO / Node loop), so the user can close the tab. The UI polls /status for
  // the live bar. Without a runner wired (tests/dev), runs inline to completion and
  // returns the finished source instead, so a self-host still mirrors synchronously.
  app.post("/v1/sync/github/:id/run", async (c) => {
    if (!(await workspaceCan(c, "publish"))) return fail(c, 403, "forbidden")
    const org = await activeWorkspace(c)
    const source = await meta.getRepoSource(c.req.param("id"), org)
    if (!source) return fail(c, 404, "not found")
    if (deps.maxArtifacts && (await meta.countArtifacts(org)) >= deps.maxArtifacts)
      return fail(c, 409, "artifact quota reached")
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
      return fail(c, userError ? 400 : 502, err instanceof Error ? err.message : "sync failed")
    }
    const fresh = (await meta.getRepoSource(source.id, org)) ?? source
    return c.json(toJson(fresh))
  })

  // ---- Status poll (drives the big progress bar) ------------------------
  // Deliberately cheap: no GitHub round-trip (unlike the list endpoint's appIsLive
  // check), just the persisted progress + status + count — so the UI polls it every
  // ~1.5s while a sync runs without hammering GitHub.
  app.get("/v1/sync/github/:id/status", async (c) => {
    if (!(await workspaceCan(c, "comment"))) return fail(c, 403, "forbidden")
    const org = await activeWorkspace(c)
    const source = await meta.getRepoSource(c.req.param("id"), org)
    if (!source) return fail(c, 404, "not found")
    const view = toJson(source)
    return c.json({
      id: source.id,
      repo: source.repo,
      progress: view.progress ?? null,
      last_status: source.last_status,
      last_synced_at: source.last_synced_at,
      file_count: view.file_count,
    })
  })

  // ---- Active syncs in this workspace (drives the global chip) ----------
  // Every source mid-sync (progress phase queued/listing/mirroring), so the app-shell
  // chip can show "Syncing <repo> · 47/190" from any page. Static path, so it never
  // collides with the `:id` routes above.
  app.get("/v1/sync/github/active", async (c) => {
    if (!(await workspaceCan(c, "comment"))) return fail(c, 403, "forbidden")
    const org = await activeWorkspace(c)
    const active = (await meta.listRepoSources(org)).filter(isSyncing).map(toJson)
    return c.json({ active })
  })

  // ---- Disconnect -------------------------------------------------------
  app.delete("/v1/sync/github/:id", async (c) => {
    if (!(await workspaceCan(c, "publish"))) return fail(c, 403, "forbidden")
    const org = await activeWorkspace(c)
    const source = await meta.getRepoSource(c.req.param("id"), org)
    if (!source) return fail(c, 404, "not found")
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
  })

  // ---- Webhook (push auto-sync + install lifecycle) ---------------------
  // GitHub posts here (no session), so it's allow-listed past the anonymous
  // lockdown and authenticated instead by the App's webhook secret over the raw
  // body. A push to a tracked repo/branch re-mirrors it; install events keep the
  // connection state honest.
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
            if (preview) await (merged ? graduatePreview(preview) : removePrPreview(preview))
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
                  await upsertPrPreview(
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
    } else if (event === "installation" && payload.action === "deleted") {
      // The App was uninstalled: drop our installation row. Synced docs are kept
      // (same as a manual disconnect); the sources just stop updating.
      if (payload.installation?.id)
        await meta.deleteGithubInstallation(String(payload.installation.id))
    }
    // installation_repositories (repos added/removed) needs no action here: a
    // removed repo's source just errors on its next sync, and an added repo is
    // connected explicitly through the picker.

    return c.json({ ok: true })
  })

  return app
}
