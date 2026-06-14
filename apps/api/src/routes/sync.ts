import { newId, type RepoSourceRecord } from "@dock/core"
import { Hono } from "hono"
import { z } from "zod"
import type { AppContext } from "../context"
import { GitHubError, parseRepo } from "../lib/github"
import { fail, readJson } from "../lib/http"
import { runSync } from "../lib/sync"

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

/**
 * Sync from GitHub: mirror a repo's Markdown/HTML into a collection, one-way.
 * Four endpoints — connect, list, run ("Sync now"), disconnect. Synced artifacts
 * are read-only (the gate lives in the publish/propose routes); this just manages
 * the connection and drives the engine (lib/sync).
 */
export const syncRoutes = (ctx: AppContext) => {
  const { meta, deps, currentUser, activeWorkspace, workspaceCan } = ctx
  const app = new Hono()

  app.get("/v1/sync/github", async (c) => {
    if (!(await workspaceCan(c, "comment"))) return fail(c, 403, "forbidden")
    const sources = await meta.listRepoSources(await activeWorkspace(c))
    return c.json({ sources: sources.map(toJson) })
  })

  app.post("/v1/sync/github", async (c) => {
    if (!(await workspaceCan(c, "publish"))) return fail(c, 403, "forbidden")
    const body = await readJson(
      c,
      z.object({
        repo: z.string(),
        ref: z.string().optional(),
        includes: z.string().optional(),
        token: z.string().optional(),
      }),
    )
    if (body instanceof Response) return body
    const parsed = parseRepo(body.repo)
    if (!parsed) return fail(c, 400, "repo must be owner/name")
    const repo = `${parsed.owner}/${parsed.name}`
    const org = await activeWorkspace(c)
    const createdBy = (await currentUser(c))?.id ?? "anon"
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
    const source = await meta.createRepoSource({
      id: newId("rs"),
      org_id: org,
      collection_id: col.id,
      repo,
      ref: body.ref?.trim() || "HEAD",
      includes: body.includes?.trim() || DEFAULT_INCLUDES,
      token: body.token?.trim() || null,
      created_by: createdBy,
    })
    return c.json(toJson(source), 201)
  })

  app.post("/v1/sync/github/:id/run", async (c) => {
    if (!(await workspaceCan(c, "publish"))) return fail(c, 403, "forbidden")
    const org = await activeWorkspace(c)
    const source = await meta.getRepoSource(c.req.param("id"), org)
    if (!source) return fail(c, 404, "not found")
    try {
      const result = await runSync(meta, deps.blobs, source, new Date().toISOString())
      return c.json(result)
    } catch (err) {
      const msg = err instanceof Error ? err.message : "sync failed"
      // Record the failure on the source (without touching the file map) so the
      // UI can show it, then surface it. A GitHub <500 is a bad repo/token (the
      // caller's to fix → 400); anything else is an upstream failure → 502.
      await meta.updateRepoSourceSync(source.id, {
        files: source.files,
        last_synced_at: new Date().toISOString(),
        last_status: `error: ${msg}`.slice(0, 300),
      })
      const userError = err instanceof GitHubError && err.status < 500
      return fail(c, userError ? 400 : 502, msg)
    }
  })

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

  return app
}
