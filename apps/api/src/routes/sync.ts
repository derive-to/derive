import type { GitHubAppRecord, RepoSourceRecord } from "@dock/core"
import { newId } from "@dock/core"
import { Hono } from "hono"
import { z } from "zod"
import type { AppContext } from "../context"
import { decryptSecret, encryptSecret, signState, verifyState } from "../lib/crypto"
import { GitHubError, parseRepo } from "../lib/github"
import { installationToken, listInstallationRepos, verifyWebhookSignature } from "../lib/github-app"
import { fail, MAX_UPLOAD_BYTES, readJson } from "../lib/http"
import { runSync } from "../lib/sync"
import { log } from "../log"

const DEFAULT_INCLUDES = "**/*.md,**/*.html"

/** Client-safe view of a source: the token is redacted and the (potentially
 *  large) file map collapses to a count. */
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
}

/**
 * Sync from GitHub: mirror a repo's Markdown/HTML into a collection, one-way.
 * Two ways in — a GitHub App (install → pick repos → push auto-sync, no stored
 * secret) or a pasted read-only PAT (self-host without an App). Synced artifacts
 * are read-only (the gate lives in the publish/propose routes); this manages the
 * connection, the App install handshake, and drives the engine (lib/sync).
 */
export const syncRoutes = (ctx: AppContext) => {
  const { meta, deps, currentUser, activeWorkspace, workspaceCan, overStorage, background } = ctx
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

  // The effective read token for a source: a freshly-minted installation token
  // (App path) or the decrypted PAT (BYO path). Null when neither applies (a
  // public repo synced without either).
  const tokenForSource = async (source: RepoSourceRecord): Promise<string | null> => {
    if (source.installation_id) {
      const loaded = await loadApp()
      if (!loaded) throw new GitHubError(400, "GitHub App is not configured on this instance")
      return installationToken(loaded.app.app_id, loaded.pem, source.installation_id)
    }
    return source.token && deps.encryptionKey
      ? decryptSecret(source.token, deps.encryptionKey)
      : source.token
  }

  // Run one source now. Shared by the manual "Sync now" button and the webhook's
  // push auto-sync. runSync persists its own status + partial file map, so a
  // mid-run failure can't orphan artifacts.
  const syncOne = (source: RepoSourceRecord, token: string | null) =>
    runSync(meta, deps.blobs, { ...source, token }, new Date().toISOString(), {
      maxBytes: MAX_UPLOAD_BYTES,
      overStorage: (n) => overStorage(source.org_id, n),
    })

  // ---- List + connection status -----------------------------------------
  app.get("/v1/sync/github", async (c) => {
    if (!(await workspaceCan(c, "comment"))) return fail(c, 403, "forbidden")
    const org = await activeWorkspace(c)
    const [sources, installs, loaded] = await Promise.all([
      meta.listRepoSources(org),
      meta.listGithubInstallations(org),
      loadApp(),
    ])
    return c.json({
      sources: sources.map(toJson),
      // What the UI needs to pick its entry point: is an App set up (→ Connect
      // button + slug for the install link), and which installations this
      // workspace already has (→ jump straight to the repo picker).
      app: loaded ? { configured: true, slug: loaded.app.slug } : { configured: false },
      installations: installs.map((i) => ({
        installation_id: i.installation_id,
        account_login: i.account_login,
      })),
    })
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
    return c.json(toJson(source), 201)
  })

  // ---- Manual "Sync now" ------------------------------------------------
  app.post("/v1/sync/github/:id/run", async (c) => {
    if (!(await workspaceCan(c, "publish"))) return fail(c, 403, "forbidden")
    const org = await activeWorkspace(c)
    const source = await meta.getRepoSource(c.req.param("id"), org)
    if (!source) return fail(c, 404, "not found")
    if (deps.maxArtifacts && (await meta.countArtifacts(org)) >= deps.maxArtifacts)
      return fail(c, 409, "artifact quota reached")
    try {
      // A GitHub <500 is a bad repo/token/install (the caller's to fix → 400); else 502.
      const token = await tokenForSource(source)
      return c.json(await syncOne(source, token))
    } catch (err) {
      const userError = err instanceof GitHubError && err.status < 500
      return fail(c, userError ? 400 : 502, err instanceof Error ? err.message : "sync failed")
    }
  })

  // ---- Disconnect -------------------------------------------------------
  app.delete("/v1/sync/github/:id", async (c) => {
    if (!(await workspaceCan(c, "publish"))) return fail(c, 403, "forbidden")
    const org = await activeWorkspace(c)
    const source = await meta.getRepoSource(c.req.param("id"), org)
    if (!source) return fail(c, 404, "not found")
    // Disconnect only: keep the collection + mirrored artifacts so the docs stay
    // readable. They simply stop updating.
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
        const matched = sources.filter(
          (s) =>
            s.repo.toLowerCase() === fullName.toLowerCase() &&
            (s.ref === branch || (s.ref === "HEAD" && branch === defaultBranch)),
        )
        // Re-sync each match off the hot path; failures are persisted per-source.
        for (const s of matched)
          background(
            tokenForSource(s)
              .then((tok) => syncOne(s, tok))
              .catch((err) =>
                log.error("push auto-sync failed", {
                  repo: s.repo,
                  error: err instanceof Error ? err.message : String(err),
                }),
              ),
          )
        if (matched.length) log.info("push auto-sync queued", { repo: fullName, n: matched.length })
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
