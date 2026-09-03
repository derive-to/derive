import {
  type BibOp,
  BibtexError,
  type BundleManifest,
  hasArtifactStanding,
  LATEX_BUNDLE_CONTENT_TYPE,
  publish,
  SKILL_CONTENT_TYPE,
  spliceBibtex,
  toJson,
} from "@derive/core"
import { z } from "@hono/zod-openapi"
import { type Context, Hono } from "hono"
import type { AppContext } from "../context"
import { afterPublish } from "../lib/after-publish"
import { AGENT_WRITES_OFF, agentWritesOff } from "../lib/agent-writes"
import { cleanPath, manifestOf, mergeBundleZip, pageTextResolver } from "../lib/bundle"
import { fail, MAX_UPLOAD_BYTES, readJson } from "../lib/http"
import { type PaperBibliography, paperBibliography } from "../lib/latex-bundle"

/** Files the editor may open by path: a paper's sources and styles, plus the text a
 *  bundle usually carries beside them. Binary files are not text and never leave here. */
const EDITABLE_FILE = /\.(tex|latex|bib|bbl|sty|cls|bst|txt|md|html?|css|js|json)$/i

const fileBody = z.object({
  source: z.string().max(1_000_000),
  base_version: z.number().int().positive(),
  message: z.string().max(500).optional(),
  title: z.string().trim().min(1).max(200).optional(),
})

const bibOp = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("set"),
    key: z.string().min(1).max(200).optional(),
    raw: z.string().min(1).max(100_000),
  }),
  z.object({ op: z.literal("delete"), key: z.string().min(1).max(200) }),
])
const bibBody = z.object({
  base_version: z.number().int().positive(),
  ops: z.array(bibOp).min(1).max(50),
  message: z.string().max(500).optional(),
})

const bibJson = (version: number, bib: PaperBibliography) => ({
  version,
  path: bib.path,
  entries: bib.entries.map((e) => ({
    key: e.key,
    type: e.type,
    fields: e.fields,
    line: e.line,
    raw: e.raw,
  })),
  cited: bib.cited,
  diagnostics: bib.diagnostics,
})

const bibMessage = (ops: BibOp[], path: string): string => {
  const first = ops[0]
  if (ops.length !== 1 || !first) return `Edited ${ops.length} references in ${path}`
  if (first.op === "delete") return `Removed ${first.key} from ${path}`
  return first.key ? `Edited ${first.key} in ${path}` : `Added a reference to ${path}`
}

/**
 * One text file of a bundle, and a paper's bibliography as entries. The browser's
 * source editor (main.tex, refs.bib, an `\input` section), its References panel and an
 * agent adding a citation all republish the bundle with one file replaced: the
 * SKILL.md editor's shape, behind the same gates as a publish.
 */
export const paperFileRoutes = (ctx: AppContext) => {
  const {
    meta,
    blobs,
    bus,
    notify,
    notifyRender,
    background,
    search,
    summarize,
    deps,
    requireArtifact,
    actingUser,
    actingHuman,
    actorFor,
    agentFor,
    limited,
    publishLimiter,
    billingGate,
    overStorage,
    blockCopy,
  } = ctx
  const app = new Hono()
  type Artifact = NonNullable<Awaited<ReturnType<typeof meta.getByShortId>>>

  // `?v=` reads any version the caller may see; writes never take it.
  const versionFor = async (c: Context, artifact: Artifact): Promise<number | Response> => {
    const raw = c.req.query("v")
    if (raw === undefined || raw === "") return artifact.current_version
    const n = Number(raw)
    if (!Number.isInteger(n) || n < 1) return fail(c, 400, "v must be a positive integer")
    // Private history stays private: the raw routes' rule and 404 shape.
    if (
      n !== artifact.current_version &&
      !artifact.public_history &&
      !hasArtifactStanding(await actorFor(c, artifact), artifact.workspace_access)
    )
      return fail(c, 404, "not found")
    return n
  }

  /** The bundle-relative path after `/files/`, decoded and normalised; 400 on traversal. */
  const filePath = (c: Context): string | Response => {
    const marker = "/files/"
    const at = c.req.path.indexOf(marker)
    let path: string
    try {
      path = cleanPath(decodeURIComponent(c.req.path.slice(at + marker.length)))
    } catch {
      return fail(c, 400, "bad path")
    }
    if (!path || path.split("/").some((seg) => seg === "" || seg === "." || seg === ".."))
      return fail(c, 400, "bad path")
    return path
  }

  const bundleOf = async (artifact: Artifact, n: number) => {
    const version = await meta.getVersion(artifact.id, n)
    const manifest = version ? await manifestOf(blobs, version) : null
    return version && manifest ? { version, manifest } : null
  }

  const paperOf = async (c: Context, artifact: Artifact, n: number) => {
    const b = await bundleOf(artifact, n)
    if (!b || b.version.content_type !== LATEX_BUNDLE_CONTENT_TYPE)
      return fail(
        c,
        404,
        "not a paper bundle: publish main.tex together with its .bib file to edit references here",
      )
    const bib = await paperBibliography(blobs, b.manifest)
    if (!bib)
      return fail(
        c,
        404,
        "this paper names no bibliography: add \\bibliography{refs} to main.tex and refs.bib to the bundle",
      )
    if ("missing" in bib)
      return fail(c, 404, `${bib.missing}.bib is named by \\bibliography but is not in the bundle`)
    return { ...b, bib }
  }

  /** The write gate after publish standing: the lock, the workspace's agent-write switch
   *  (an agent editing a file is an agent writing content), the publish lane, billing,
   *  then the version the caller edited against. */
  const gate = async (c: Context, artifact: Artifact, baseVersion: number) => {
    if (artifact.locked) return fail(c, 409, "artifact is locked — unlock it to publish")
    if ((await agentFor(c)) && (await agentWritesOff(meta, artifact.org_id)))
      return fail(c, 403, AGENT_WRITES_OFF)
    const rl = await limited(c, publishLimiter)
    if (rl) return rl
    const blocked = await billingGate(c, artifact.org_id)
    if (blocked) return blocked
    if (baseVersion !== artifact.current_version)
      return fail(
        c,
        409,
        `"${artifact.short_id}" moved to v${artifact.current_version} while you were editing (you read v${baseVersion}). Reload, then retry.`,
      )
    return null
  }

  /** Republish the bundle with `files` overlaid, attributed like any publish. */
  const republish = async (
    c: Context,
    artifact: Artifact,
    manifest: BundleManifest,
    files: Record<string, string>,
    message: string,
    title?: string,
  ) => {
    const bytes = await mergeBundleZip(blobs, manifest, files)
    if (bytes.length > MAX_UPLOAD_BYTES) return fail(c, 413, "upload too large")
    if (await overStorage(artifact.org_id, bytes.length))
      return fail(c, 413, blockCopy.storage.message, { code: blockCopy.storage.code })
    const human = await actingHuman(c)
    const actor = (await actingUser(c)) ?? human
    const agent = await agentFor(c)
    const saved = await publish(
      meta,
      blobs,
      {
        bytes,
        filename: "paper.zip",
        isBundle: true,
        spa: manifest.spa,
        title: title ?? artifact.title ?? undefined,
        message,
        author: human?.name ?? actor?.name ?? undefined,
        authorId: human?.id ?? null,
        agentId: actor && actor.id !== human?.id ? actor.id : null,
        agentName: actor && actor.id !== human?.id ? actor.name : null,
        source: agent ? "api" : "web",
        existingArtifact: artifact,
      },
      artifact.short_id,
    )
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
      saved.artifact,
      saved.version,
      {
        isNew: false,
        onBehalf: human?.id ?? null,
        actorId: actor?.id ?? null,
        actorName: actor?.name ?? null,
      },
    )
    return saved
  }

  app.get("/v1/artifacts/:shortId/files/*", async (c) => {
    const artifact = await requireArtifact(c, "read")
    if (artifact instanceof Response) return artifact
    const path = filePath(c)
    if (path instanceof Response) return path
    const n = await versionFor(c, artifact)
    if (n instanceof Response) return n
    const b = await bundleOf(artifact, n)
    if (!b) return fail(c, 404, "not a bundle")
    if (!EDITABLE_FILE.test(path)) return fail(c, 404, "not a text file")
    const text = await pageTextResolver(blobs, b.version)
    const source = await text(path)
    if (source === null) return fail(c, 404, `no file "${path}" in this bundle`)
    return c.json({ path, source, version: b.version.n })
  })

  app.put("/v1/artifacts/:shortId/files/*", async (c) => {
    const artifact = await requireArtifact(c, "publish", { split: true })
    if (artifact instanceof Response) return artifact
    const path = filePath(c)
    if (path instanceof Response) return path
    const body = await readJson(c, fileBody)
    if (body instanceof Response) return body
    const gated = await gate(c, artifact, body.base_version)
    if (gated) return gated
    if (!EDITABLE_FILE.test(path)) return fail(c, 400, "only text files can be edited here")
    if (artifact.current_content_type === SKILL_CONTENT_TYPE && path === "SKILL.md")
      return fail(c, 400, "edit SKILL.md through /skill-source")
    const b = await bundleOf(artifact, artifact.current_version)
    if (!b) return fail(c, 404, "not a bundle")
    if (!(b.manifest.files[`/${path}`] ?? b.manifest.files[path]))
      return fail(c, 404, `no file "${path}" in this bundle`)
    const saved = await republish(
      c,
      artifact,
      b.manifest,
      { [path]: body.source },
      body.message?.trim() || `Edited ${path} in browser`,
      body.title,
    )
    if (saved instanceof Response) return saved
    return c.json({
      ...toJson(deps.baseUrl, saved.artifact, await meta.listVersions(saved.artifact.id)),
      file: { path, version: saved.version.n },
    })
  })

  app.get("/v1/artifacts/:shortId/bib", async (c) => {
    const artifact = await requireArtifact(c, "read")
    if (artifact instanceof Response) return artifact
    const n = await versionFor(c, artifact)
    if (n instanceof Response) return n
    const paper = await paperOf(c, artifact, n)
    if (paper instanceof Response) return paper
    return c.json(bibJson(paper.version.n, paper.bib))
  })

  app.put("/v1/artifacts/:shortId/bib", async (c) => {
    const artifact = await requireArtifact(c, "publish", { split: true })
    if (artifact instanceof Response) return artifact
    const body = await readJson(c, bibBody)
    if (body instanceof Response) return body
    const gated = await gate(c, artifact, body.base_version)
    if (gated) return gated
    const paper = await paperOf(c, artifact, artifact.current_version)
    if (paper instanceof Response) return paper
    let spliced: ReturnType<typeof spliceBibtex>
    try {
      spliced = spliceBibtex(paper.bib.source, body.ops)
    } catch (e) {
      if (e instanceof BibtexError) return fail(c, 400, e.message)
      throw e
    }
    const saved = await republish(
      c,
      artifact,
      paper.manifest,
      { [paper.bib.path]: spliced.source },
      body.message?.trim() || bibMessage(body.ops, paper.bib.path),
    )
    if (saved instanceof Response) return saved
    return c.json({
      ...toJson(deps.baseUrl, saved.artifact, await meta.listVersions(saved.artifact.id)),
      bib: bibJson(saved.version.n, { ...paper.bib, entries: spliced.entries }),
    })
  })

  return app
}
