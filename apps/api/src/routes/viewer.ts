import { renderShell } from "@dock/core"
import { Hono } from "hono"
import type { AppContext } from "../context"
import { REF_RE, TOMBSTONE } from "../lib/http"

/** The viewer shell at `/a/:ref` — the iframe host that points at the sandboxed
 *  raw bytes. `ref` = shortId[-slug][@vN]. */
export const viewerRoutes = (ctx: AppContext) => {
  const { meta, deps, authorize } = ctx
  const app = new Hono()

  app.get("/a/:ref", async (c) => {
    const m = REF_RE.exec(c.req.param("ref"))
    if (!m) return c.text("not found", 404)
    const artifact = await meta.getByShortId(m[1])
    if (!artifact || artifact.current_version === 0 || !(await authorize(c, "read", artifact)))
      return c.text("not found", 404)
    if (artifact.removed_at) return c.text(TOMBSTONE, 410)
    const n = m[2] ? Number(m[2]) : artifact.current_version
    const version = await meta.getVersion(artifact.id, n)
    if (!version) return c.text(`no version ${n}`, 404)
    const versions = await meta.listVersions(artifact.id)
    // Point the iframe straight at the sandbox origin when split (skips the
    // redirect hop); same-origin otherwise.
    const rawSrc = `${deps.sandboxOrigin ?? ""}/raw/${artifact.short_id}/v/${n}/index.html`
    return c.html(renderShell(artifact, versions, n, rawSrc))
  })

  return app
}
