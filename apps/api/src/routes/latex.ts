import {
  type ArtifactRecord,
  artifactUrl,
  type BundleManifest,
  blobRefOfUrl,
  blobRefsIn,
  type DynamicValue,
  hasArtifactStanding,
  isBundleContentType,
  isLatexLike,
  isLatexTemplateId,
  LATEX_BUNDLE_CONTENT_TYPE,
  latexTemplateSummaries,
  planLatexExport,
  validateDynamicValue,
} from "@derive/core"
import { zipSync } from "fflate"
import type { Context } from "hono"
import { Hono } from "hono"
import type { AppContext } from "../context"
import { fail, TOMBSTONE, toBody } from "../lib/http"
import { latexTemplateBundle } from "../lib/latex-templates"
import { log } from "../log"

/** The unzipped ceiling of a source export, the same bound a bundle publish has. */
const MAX_EXPORT_BYTES = 50 * 1024 * 1024

/** Bundle files read as text into the export plan (the rest travel as bytes). */
const TEXT_FILE = /\.(tex|latex|bib|bbl|sty|cls|bst|txt|md)$/i

const EXT_OF_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "application/pdf": "pdf",
}

/**
 * LaTeX papers: the starters a person or agent creates a paper from, and the source zip
 * that compiles a paper the way the page shows it.
 *
 * Creating from a template is not a route of its own: the client (the web's New page, an
 * MCP `publish({ files })`, `derive init`) takes the files map from here and publishes it
 * through the one publish path, so every guard and receipt stays where it is.
 */
export const latexRoutes = (ctx: AppContext) => {
  const { meta, blobs, deps, requireArtifact, actorFor, actingUser, agentFor, isToken } = ctx
  const app = new Hono()

  // Signed-in people and agents. Anonymous callers get nothing: the CVPR starter costs an
  // upstream fetch, and a starter is of no use to someone who cannot publish.
  const signedIn = async (c: Context): Promise<boolean> =>
    !!(await actingUser(c)) || !!(await agentFor(c)) || isToken(c)

  app.get("/v1/latex/templates", async (c) => {
    if (!(await signedIn(c))) return fail(c, 401, "unauthenticated")
    return c.json({ templates: latexTemplateSummaries() })
  })

  app.get("/v1/latex/templates/:id", async (c) => {
    if (!(await signedIn(c))) return fail(c, 401, "unauthenticated")
    const id = c.req.param("id") ?? ""
    if (!isLatexTemplateId(id)) return fail(c, 404, `no paper template "${id}"`)
    return c.json(await latexTemplateBundle(id, deps.fetch ?? fetch))
  })

  // Private history requires artifact standing, the same gate the raw routes apply.
  const privateHistoryBlocked = async (c: Context, artifact: ArtifactRecord, n: number) =>
    n !== artifact.current_version &&
    !artifact.public_history &&
    !hasArtifactStanding(await actorFor(c, artifact), artifact.workspace_access)

  app.get("/v1/artifacts/:shortId/source.zip", async (c) => {
    const artifact = await requireArtifact(c, "read")
    if (artifact instanceof Response) return artifact
    if (artifact.current_version === 0) return fail(c, 404, "not found")
    if (artifact.removed_at) return fail(c, 410, TOMBSTONE)
    const vq = c.req.query("v")
    const n = vq ? Number.parseInt(vq, 10) : artifact.current_version
    if (!Number.isInteger(n) || n < 1) return fail(c, 400, "invalid version")
    if (await privateHistoryBlocked(c, artifact, n)) return fail(c, 404, "not found")
    const version = await meta.getVersion(artifact.id, n)
    if (!version) return fail(c, 404, "version not found")
    const ct = version.content_type
    if (!isLatexLike(ct) && ct !== LATEX_BUNDLE_CONTENT_TYPE)
      return fail(c, 400, "this artifact is not a LaTeX paper")

    // The sources: every bundle file at its path, or the single file as main.tex.
    const files: Record<string, string | Uint8Array> = {}
    let entry = "main.tex"
    let total = 0
    const take = (bytes: Uint8Array): boolean => {
      total += bytes.byteLength
      return total <= MAX_EXPORT_BYTES
    }
    if (isBundleContentType(ct)) {
      const manifestBytes = await blobs.get(version.blob_key)
      if (!manifestBytes) return fail(c, 500, "blob missing")
      const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as BundleManifest
      entry = manifest.entry.replace(/^\//, "")
      for (const [path, file] of Object.entries(manifest.files)) {
        const bytes = await blobs.get(file.key)
        if (!bytes) continue
        if (!take(bytes)) return fail(c, 413, "the source export exceeds 50 MB")
        const clean = path.replace(/^\//, "")
        files[clean] = TEXT_FILE.test(clean) ? new TextDecoder().decode(bytes) : bytes
      }
    } else {
      const bytes = await blobs.get(version.blob_key)
      if (!bytes) return fail(c, 500, "blob missing")
      files[entry] = new TextDecoder().decode(bytes)
    }

    // The version's dynamic slots, defensively parsed like the serve path does.
    const slots: Record<string, DynamicValue> = {}
    const slotRevisions: Record<string, number> = {}
    let rows: Awaited<ReturnType<typeof meta.listDynamicSlots>> = []
    try {
      rows = await meta.listDynamicSlots(artifact.id, n)
    } catch (err) {
      log.warn("latex_export_slots_unavailable", {
        short_id: artifact.short_id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    for (const row of rows) {
      try {
        const value = validateDynamicValue(JSON.parse(row.json))
        if (typeof value === "string") continue
        slots[row.name] = value
        slotRevisions[row.name] = row.revision
      } catch {}
    }

    // Uploaded figures: every /blob/<sha> the sources or the figure slots point at, read
    // through the asset row so only real assets are bundled.
    const refs = new Map<string, string | null>()
    for (const value of Object.values(files))
      if (typeof value === "string") for (const r of blobRefsIn(value)) refs.set(r.sha, r.ext)
    for (const value of Object.values(slots)) {
      const r = value.kind === "figure" ? blobRefOfUrl(value.figure.url) : null
      if (r) refs.set(r.sha, r.ext)
    }
    const blobFiles: Record<string, { bytes: Uint8Array; ext: string }> = {}
    for (const [sha, refExt] of refs) {
      const asset = await meta.getAsset(sha)
      if (!asset) continue
      const bytes = await blobs.get(sha)
      if (!bytes) continue
      if (!take(bytes)) return fail(c, 413, "the source export exceeds 50 MB")
      const base = asset.content_type.split(";")[0]?.trim() ?? ""
      blobFiles[sha] = { bytes, ext: EXT_OF_TYPE[base] ?? refExt ?? "png" }
    }

    const plan = planLatexExport({
      entry,
      files,
      slots,
      slotRevisions,
      blobs: blobFiles,
      meta: {
        title: artifact.title,
        shortId: artifact.short_id,
        version: n,
        url: artifactUrl(deps.baseUrl, artifact),
        exportedAt: new Date().toISOString(),
      },
    })
    const encoder = new TextEncoder()
    const zip = zipSync(
      Object.fromEntries(
        Object.entries(plan.files).map(([path, value]) => [
          path,
          typeof value === "string" ? encoder.encode(value) : value,
        ]),
      ),
    )
    log.info("latex_export", {
      short_id: artifact.short_id,
      n,
      files: Object.keys(plan.files).length,
      bytes: zip.byteLength,
      notes: plan.notes.length,
    })
    const name = (artifact.title ?? artifact.short_id).replace(/[^a-z0-9._-]+/gi, "-").slice(0, 100)
    return c.body(toBody(zip), 200, {
      "Content-Type": "application/zip",
      "Content-Length": String(zip.byteLength),
      "Content-Disposition": `attachment; filename="${name}-v${n}-source.zip"`,
      // The payload changes with every slot update, so nothing may keep a copy.
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    })
  })

  return app
}
