import { Hono, type Context } from "hono"
import { streamSSE } from "hono/streaming"
import { Presence, createBus } from "./bus"
import type { Auth } from "./auth-config"
import {
  BUNDLE_CONTENT_TYPE,
  PublishError,
  artifactUrl,
  SELECTION_SCRIPT,
  diffLines,
  formatDiff,
  isAnchored,
  mimeFor,
  newId,
  publish,
  renderMarkdown,
  renderShell,
  toJson,
  type ArtifactRecord,
  type BlobStore,
  type BundleManifest,
  type MetaStore,
  type VersionRecord,
  type Visibility,
} from "@dock/core"

interface SessionUser {
  id: string
  email: string
  name: string | null
}

export interface AppDeps {
  meta: MetaStore
  blobs: BlobStore
  baseUrl: string
  /** A static token (CI/agents) authorizes writes + gated reads, alongside a login session. */
  token?: string
  /** Better Auth instance — mounts /api/auth/* and provides the session. */
  auth?: Auth
}

const VISIBILITIES = ["public", "link", "org", "password"] as const

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024

/** Headers for everything inside the artifact sandbox. */
const RAW_HEADERS: Record<string, string> = {
  // Opaque origin: scripts run, but can touch no cookies, storage, or APIs.
  "Content-Security-Policy": "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads",
  "Access-Control-Allow-Origin": "*",
  "X-Content-Type-Options": "nosniff",
  // Versioned paths are immutable by construction.
  "Cache-Control": "public, max-age=31536000, immutable",
}

const REF_RE = /^([0-9a-z]{6,12})(?:-[a-z0-9-]*)?(?:@v(\d+))?$/

/** Copy into a plain ArrayBuffer — what Hono's body() accepts. */
const toBody = (u: Uint8Array): ArrayBuffer => new Uint8Array(u).buffer as ArrayBuffer

/**
 * Embedded mode serves bundles under /raw/:id/v/:n/, so root-absolute URLs
 * (href="/x", src="/x", url(/x)) must be prefixed or they escape the artifact.
 * Domain mode (per-artifact origin) makes this a no-op later.
 */
const rewriteAbsoluteUrls = (text: string, prefix: string): string =>
  text
    .replace(/(\b(?:href|src|action|srcset|poster)=["'])\/(?!\/)/g, `$1${prefix}/`)
    .replace(/(url\(\s*['"]?)\/(?!\/)/g, `$1${prefix}/`)

export function createApp(deps: AppDeps): Hono {
  const { meta, blobs } = deps
  const app = new Hono()
  const bus = createBus()
  const presence = new Presence()

  const bearer = (c: Context): string => {
    const h = c.req.header("authorization") ?? ""
    return h.startsWith("Bearer ") ? h.slice(7) : ""
  }

  const currentUser = async (c: Context): Promise<SessionUser | null> => {
    if (!deps.auth) return null
    const s = await deps.auth.api.getSession({ headers: c.req.raw.headers })
    return s?.user ? { id: s.user.id, email: s.user.email, name: s.user.name ?? null } : null
  }

  // A static token (CI/agents) or a valid login session authorizes writes;
  // gated reads need one too. No token + no session = open dev instance.
  const writeOk = async (c: Context): Promise<boolean> =>
    !deps.token || bearer(c) === deps.token || (await currentUser(c)) !== null
  const readOk = async (c: Context, a: ArtifactRecord): Promise<boolean> =>
    a.visibility === "public" ||
    a.visibility === "link" ||
    !deps.token ||
    bearer(c) === deps.token ||
    (await currentUser(c)) !== null

  // Better Auth owns /api/auth/* (sign-up/in/out, OAuth, OIDC/SSO, session).
  if (deps.auth) {
    const auth = deps.auth
    app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw))
  }

  app.get("/healthz", (c) => c.json({ ok: true }))

  app.get("/", (c) =>
    c.html(
      `<!doctype html><meta charset="utf-8"><title>Dock</title>
<body style="font:16px/1.6 system-ui;background:#f6f0e3;color:#2a2540;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><h1 style="letter-spacing:-.02em">Dock</h1>
<p>An open home for AI-generated artifacts.<br>
<code style="background:#eee7d6;padding:2px 8px;border-radius:6px">dock publish ./your-thing</code></p></div>`,
    ),
  )

  app.get("/v1/me", async (c) => {
    const u = await currentUser(c)
    return u ? c.json({ user: u }) : c.json({ error: "unauthenticated" }, 401)
  })

  app.get("/v1/artifacts", async (c) => {
    if (!(await currentUser(c)) && deps.token && bearer(c) !== deps.token)
      return c.json({ error: "unauthenticated" }, 401)
    const artifacts = await meta.listArtifacts({ limit: 200 })
    return c.json({ artifacts: artifacts.map((a) => toJson(deps.baseUrl, a, [])) })
  })

  // ---- Publish ----------------------------------------------------------

  const handlePublish = async (c: Context, shortId?: string) => {
    if (!(await writeOk(c))) return c.json({ error: "unauthorized" }, 401)
    const len = Number(c.req.header("content-length") ?? 0)
    if (len > MAX_UPLOAD_BYTES) return c.json({ error: "upload too large" }, 413)

    const body = await c.req.parseBody()
    const file = body["file"]
    if (!(file instanceof File)) return c.json({ error: "multipart field 'file' required" }, 400)

    const bytes = new Uint8Array(await file.arrayBuffer())
    const isBundle =
      /\.zip$/i.test(file.name) ||
      body["kind"] === "bundle" ||
      (bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 3 || bytes[2] === 5))

    try {
      const { artifact, version } = await publish(
        meta,
        blobs,
        {
          bytes,
          filename: file.name,
          isBundle,
          title: str(body["title"]),
          slug: str(body["slug"]),
          spa: body["spa"] === "true" || body["spa"] === "1",
          message: str(body["message"]),
          author: str(body["author"]),
          visibility: visibilityOf(body["visibility"]),
        },
        shortId,
      )
      bus.publish(artifact.id, {
        type: "version.published",
        n: version.n,
        message: version.message,
      })
      // Republish can resolve comment threads in the same call.
      const resolves = body["resolves"]
      if (shortId && typeof resolves === "string" && resolves) {
        for (const cid of resolves.split(",").map((s) => s.trim()).filter(Boolean)) {
          const cm = await meta.getComment(cid)
          if (cm && cm.artifact_id === artifact.id) {
            await meta.setThreadState(artifact.id, cm.thread_id, "resolved")
            bus.publish(artifact.id, { type: "comment.resolved", thread_id: cm.thread_id })
          }
        }
      }
      const versions = await meta.listVersions(artifact.id)
      return c.json({ ...toJson(deps.baseUrl, artifact, versions), published: version.n }, 201)
    } catch (err) {
      if (err instanceof PublishError) return c.json({ error: err.message }, err.statusCode as 400)
      throw err
    }
  }

  app.post("/v1/artifacts", (c) => handlePublish(c))
  app.post("/v1/artifacts/:shortId/versions", (c) => handlePublish(c, c.req.param("shortId")))

  app.get("/v1/artifacts/:shortId", async (c) => {
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact || !(await readOk(c, artifact))) return c.json({ error: "not found" }, 404)
    return c.json(toJson(deps.baseUrl, artifact, await meta.listVersions(artifact.id)))
  })

  /** Source text of a version (entry document for bundles); null if missing. */
  const sourceText = async (version: VersionRecord): Promise<string | null> => {
    let data: Uint8Array | null
    if (version.content_type === BUNDLE_CONTENT_TYPE) {
      const manifestBytes = await blobs.get(version.blob_key)
      if (!manifestBytes) return null
      const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as BundleManifest
      data = await blobs.get(manifest.files[manifest.entry].key)
    } else {
      data = await blobs.get(version.blob_key)
    }
    return data ? new TextDecoder().decode(data) : null
  }

  // Source read-back for machines: returns an artifact's text content for any
  // version, as plain text (?v=N selects a version; defaults to current).
  app.get("/v1/artifacts/:shortId/content", async (c) => {
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact || artifact.current_version === 0 || !(await readOk(c, artifact)))
      return c.json({ error: "not found" }, 404)
    const v = c.req.query("v") ? Number(c.req.query("v")) : artifact.current_version
    if (!Number.isInteger(v)) return c.json({ error: "bad version" }, 400)
    const version = await meta.getVersion(artifact.id, v)
    if (!version) return c.json({ error: `no version ${v}` }, 404)
    const src = await sourceText(version)
    if (src === null) return c.json({ error: "blob missing" }, 500)
    c.header("Content-Type", "text/plain; charset=utf-8")
    c.header("X-Content-Type-Options", "nosniff")
    c.header("Access-Control-Allow-Origin", "*")
    c.header("X-Dock-Version", String(v))
    c.header("X-Dock-Kind", artifact.kind)
    return c.body(src)
  })

  // Line diff between two versions. Defaults to (current-1 → current).
  // ?format=json returns the structured ops; otherwise unified-style text.
  app.get("/v1/artifacts/:shortId/diff", async (c) => {
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact || artifact.current_version === 0 || !(await readOk(c, artifact)))
      return c.json({ error: "not found" }, 404)
    const cur = artifact.current_version
    const from = c.req.query("from") ? Number(c.req.query("from")) : Math.max(1, cur - 1)
    const to = c.req.query("to") ? Number(c.req.query("to")) : cur
    if (!Number.isInteger(from) || !Number.isInteger(to)) return c.json({ error: "bad version" }, 400)
    const [vf, vt] = [await meta.getVersion(artifact.id, from), await meta.getVersion(artifact.id, to)]
    if (!vf || !vt) return c.json({ error: "version not found" }, 404)
    const [a, b] = [await sourceText(vf), await sourceText(vt)]
    if (a === null || b === null) return c.json({ error: "blob missing" }, 500)
    const ops = diffLines(a, b)

    c.header("Access-Control-Allow-Origin", "*")
    c.header("X-Dock-From", String(from))
    c.header("X-Dock-To", String(to))
    if (c.req.query("format") === "json") return c.json({ from, to, ops })
    c.header("Content-Type", "text/plain; charset=utf-8")
    return c.body(formatDiff(ops))
  })

  // ---- Comments ----------------------------------------------------------

  // Create a comment (new thread) or a reply (pass thread_id).
  app.post("/v1/artifacts/:shortId/comments", async (c) => {
    if (!(await writeOk(c))) return c.json({ error: "unauthorized" }, 401)
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact || artifact.current_version === 0) return c.json({ error: "not found" }, 404)
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    if (typeof body.body_md !== "string" || body.body_md.trim() === "")
      return c.json({ error: "body_md required" }, 400)

    const id = newId("c")
    const threadId = typeof body.thread_id === "string" && body.thread_id ? body.thread_id : id
    const baseVersion = Number.isInteger(body.base_version)
      ? (body.base_version as number)
      : artifact.current_version
    const anchor =
      body.anchor && typeof body.anchor === "object"
        ? JSON.stringify(body.anchor)
        : typeof body.anchor === "string"
          ? body.anchor
          : null

    const me = await currentUser(c)
    const author = me
      ? (me.name ?? me.email)
      : typeof body.author === "string" && body.author
        ? body.author
        : "anonymous"
    const created = await meta.createComment({
      id,
      artifact_id: artifact.id,
      thread_id: threadId,
      base_version: baseVersion,
      path: typeof body.path === "string" ? body.path : null,
      anchor,
      body_md: body.body_md,
      author,
    })
    bus.publish(artifact.id, { type: "comment.created", comment: created })
    return c.json(created, 201)
  })

  app.get("/v1/artifacts/:shortId/comments", async (c) => {
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact || !(await readOk(c, artifact))) return c.json({ error: "not found" }, 404)
    const q = c.req.query("state")
    const state = q === "open" || q === "resolved" ? q : undefined
    const comments = await meta.listComments(artifact.id, state ? { state } : undefined)
    // Flag whether each anchor still resolves against the current version.
    const cur = await meta.getVersion(artifact.id, artifact.current_version)
    const src = cur ? await sourceText(cur) : null
    return c.json({
      comments: comments.map((cm) => ({
        ...cm,
        anchored: src === null ? true : isAnchored(cm.anchor, src),
      })),
    })
  })

  // Resolve (or reopen, with {state:"open"}) the thread a comment belongs to.
  app.post("/v1/artifacts/:shortId/comments/:commentId/resolve", async (c) => {
    if (!(await writeOk(c))) return c.json({ error: "unauthorized" }, 401)
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact) return c.json({ error: "not found" }, 404)
    const cm = await meta.getComment(c.req.param("commentId"))
    if (!cm || cm.artifact_id !== artifact.id) return c.json({ error: "not found" }, 404)
    const body = (await c.req.json().catch(() => ({}))) as { state?: string }
    const state = body.state === "open" ? "open" : "resolved"
    const updated = await meta.setThreadState(artifact.id, cm.thread_id, state)
    bus.publish(artifact.id, { type: "comment.resolved", thread_id: cm.thread_id, state })
    return c.json({ thread_id: cm.thread_id, state, updated })
  })

  // ---- Live stream (SSE) + presence -------------------------------------

  app.get("/v1/artifacts/:shortId/events", async (c) => {
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact || !(await readOk(c, artifact))) return c.text("not found", 404)
    c.header("Access-Control-Allow-Origin", "*")
    return streamSSE(c, async (stream) => {
      const unsub = bus.subscribe(artifact.id, (e) => {
        void stream.writeSSE({ event: e.type, data: JSON.stringify(e) })
      })
      stream.onAbort(unsub)
      await stream.writeSSE({ event: "ready", data: JSON.stringify({ short_id: artifact.short_id }) })
      while (!stream.aborted) {
        await stream.sleep(15000)
        await stream.writeSSE({ event: "ping", data: "{}" })
      }
    })
  })

  app.post("/v1/artifacts/:shortId/presence", async (c) => {
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact || !(await readOk(c, artifact))) return c.json({ error: "not found" }, 404)
    const body = (await c.req.json().catch(() => ({}))) as { name?: string }
    const name = typeof body.name === "string" && body.name ? body.name : "anonymous"
    const viewers = presence.heartbeat(artifact.id, name, Date.now())
    bus.publish(artifact.id, { type: "presence", viewers })
    return c.json({ viewers })
  })

  // ---- Viewer ------------------------------------------------------------

  app.get("/a/:ref", async (c) => {
    const m = REF_RE.exec(c.req.param("ref"))
    if (!m) return c.text("not found", 404)
    const artifact = await meta.getByShortId(m[1])
    if (!artifact || artifact.current_version === 0 || !(await readOk(c, artifact)))
      return c.text("not found", 404)
    const n = m[2] ? Number(m[2]) : artifact.current_version
    const version = await meta.getVersion(artifact.id, n)
    if (!version) return c.text(`no version ${n}`, 404)
    const versions = await meta.listVersions(artifact.id)
    const rawSrc = `/raw/${artifact.short_id}/v/${n}/index.html`
    return c.html(renderShell(artifact, versions, n, rawSrc))
  })

  // ---- Raw content (the sandbox) ----------------------------------------

  app.get("/raw/:shortId/v/:n/*", async (c) => {
    const shortId = c.req.param("shortId")
    const n = Number(c.req.param("n"))
    const artifact = await meta.getByShortId(shortId)
    if (!artifact || !Number.isInteger(n) || !(await readOk(c, artifact))) return c.text("not found", 404)
    const version = await meta.getVersion(artifact.id, n)
    if (!version) return c.text("not found", 404)

    const prefix = `/raw/${shortId}/v/${c.req.param("n")}/`
    let path = decodeURIComponent(c.req.path.slice(prefix.length))

    if (version.content_type === BUNDLE_CONTENT_TYPE) {
      const manifestBytes = await blobs.get(version.blob_key)
      if (!manifestBytes) return c.text("blob missing", 500)
      const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as BundleManifest

      if (path === "" || path === "index.html") path = manifest.entry.slice(1)
      let lookup = `/${path}`
      if (lookup.endsWith("/")) lookup += "index.html"
      let entry = manifest.files[lookup]
      // Pretty URLs (Astro-style dir output), then SPA fallback.
      if (!entry && !/\.[a-z0-9]+$/i.test(lookup)) entry = manifest.files[`${lookup}/index.html`]
      if (!entry && manifest.spa) entry = manifest.files[manifest.entry]
      if (!entry) return c.text("not found", 404, RAW_HEADERS)

      const data = await blobs.get(entry.key)
      if (!data) return c.text("blob missing", 500)
      if (entry.type.startsWith("text/html") || entry.type.startsWith("text/css")) {
        const rewritten = rewriteAbsoluteUrls(
          new TextDecoder().decode(data),
          prefix.slice(0, -1),
        )
        return c.body(rewritten, 200, { ...RAW_HEADERS, "Content-Type": entry.type })
      }
      return c.body(toBody(data), 200, { ...RAW_HEADERS, "Content-Type": entry.type })
    }

    const data = await blobs.get(version.blob_key)
    if (!data) return c.text("blob missing", 500)

    if (version.content_type === "text/markdown") {
      if (path === "raw.md")
        return c.body(toBody(data), 200, { ...RAW_HEADERS, "Content-Type": "text/markdown; charset=utf-8" })
      const html = await renderMarkdown(new TextDecoder().decode(data), artifact.title)
      return c.body(html, 200, { ...RAW_HEADERS, "Content-Type": "text/html; charset=utf-8" })
    }

    // html file artifact — any path serves the document (+ selection capture)
    const ct = mimeFor(path || "index.html")
    if (ct.startsWith("text/html")) {
      const html = new TextDecoder().decode(data) + SELECTION_SCRIPT
      return c.body(html, 200, { ...RAW_HEADERS, "Content-Type": ct })
    }
    return c.body(toBody(data), 200, { ...RAW_HEADERS, "Content-Type": ct })
  })

  return app
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined)

const visibilityOf = (v: unknown): Visibility | undefined =>
  typeof v === "string" && (VISIBILITIES as readonly string[]).includes(v)
    ? (v as Visibility)
    : undefined

export { artifactUrl }
