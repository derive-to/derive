import { roleAllows } from "@derive/core"
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { Context } from "hono"
import type { BlankEnv } from "hono/types"
import type { AppContext } from "../context"
import { bail, fail } from "../lib/http"
import { assetCostNote, imageDimensions, MAX_ASSET_BYTES, sniffAssetType } from "../lib/image"
import { verifyUploadToken } from "../lib/upload-token"

const EXT_FOR_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "font/woff2": "woff2",
  "font/woff": "woff",
}

/**
 * Standalone binary assets — raster images and web fonts. An agent uploads the raw
 * bytes of a screenshot or a woff2 here (a plain binary POST — no base64
 * transcription) and gets back:
 *
 *  - `url`: a permanent, unguessable public link (GET /blob/<hash>.<ext>) — paste it
 *    into ANY artifact's content (single-file HTML, markdown, a bundle page) or
 *    anywhere else (Slack, GitHub). This is the images-without-base64 path: the
 *    transport that can't carry megabytes of binary in a JSON tool call streams
 *    them as bytes instead, and the ~70-char URL rides in the doc's own text.
 *  - `ref` (`asset:<hash>`): the older handle for a bundle `publish` `files` map
 *    (resolved by decodeBundleFiles), kept for that existing path.
 *
 * Both point at the same content-addressed bytes — `url`'s hash IS `ref`'s hash.
 * `url` is a capability URL, not access-gated: the hash is unguessable (sha256 of
 * the bytes), but anyone who has it can fetch it, independent of the artifact's
 * own visibility. That trade-off is deliberate — see docs/decisions on asset URLs.
 */
export const assetRoutes = (ctx: AppContext) => {
  const { meta, blobs, requireWorkspace, overStorage, deps } = ctx
  // Contract-first: the *request* is a raw/multipart binary upload (read by hand
  // below, no JSON body schema), but the *response* is a typed handle that agents /
  // the CLI / MCP consume — so it gets a schema like every other JSON response.
  const app = new OpenAPIHono<BlankEnv>()

  // The content-addressed handle: `key` is the blob hash, `url` a permanent public
  // link to the same bytes, `ref` the exact `asset:<hash>` string for a bundle
  // `files` value, `type` the sniffed image MIME, `size` the byte length.
  const AssetRef = z
    .object({
      key: z.string().describe("The blob hash (content-addressed storage key)"),
      url: z
        .string()
        .describe("A permanent public URL for these bytes — embed it in any artifact's content"),
      ref: z.string().describe('The exact "asset:<hash>" string to drop into a publish files map'),
      type: z
        .enum(["image/png", "image/jpeg", "image/gif", "image/webp", "font/woff2", "font/woff"])
        .describe("The sniffed MIME type (PNG, JPEG, GIF, WebP, WOFF2, or WOFF)"),
      size: z.number().describe("The asset's size in bytes"),
    })
    .openapi("AssetRef")

  // The storage half, shared by both entry points below once the caller has proven
  // a workspace: read the body, sniff, quota-check, store. Returns the handle payload
  // (each route c.json()s it under its own typed context) or an error Response.
  const storeAsset = async (c: Context, org: string) => {
    const declared = Number(c.req.header("content-length") ?? 0)
    if (declared > MAX_ASSET_BYTES + 4096) return fail(c, 413, "asset too large (max 25MB)")

    // Accept either a multipart `file` field (browsers, the CLI's FormData) or a raw
    // binary body (curl --data-binary @shot.png), so an agent can stream bytes the
    // simplest way it has.
    const contentType = c.req.header("content-type") ?? ""
    let bytes: Uint8Array
    if (contentType.includes("multipart/form-data")) {
      const file = (await c.req.parseBody()).file
      if (!(file instanceof File)) return fail(c, 400, "multipart field 'file' required")
      bytes = new Uint8Array(await file.arrayBuffer())
    } else {
      bytes = new Uint8Array(await c.req.arrayBuffer())
    }

    if (bytes.byteLength === 0) return fail(c, 400, "empty asset body")
    if (bytes.byteLength > MAX_ASSET_BYTES) return fail(c, 413, "asset too large (max 25MB)")

    // Trust the bytes, not the declared type — and only store non-executable formats:
    // plain raster images and packaged web fonts (no SVG/HTML: served from our origin
    // they could carry script).
    const type = sniffAssetType(bytes)
    if (!type) return fail(c, 400, "unsupported asset (use PNG, JPEG, GIF, WebP, or WOFF/WOFF2)")

    if (await overStorage(org, bytes.byteLength)) return fail(c, 413, "storage quota exceeded")

    const key = await blobs.put(bytes)
    // Read the pixel dimensions from the header (fonts have none). These are the user's
    // bytes, so nothing is re-encoded — but what an upload COSTS should be legible at the
    // moment it is made, not discovered later by a viewer on a slow connection.
    const size = imageDimensions(bytes)
    // Content-addressed row: this is the allowlist that makes GET /blob/:hash
    // servable at all (the blob store also holds manifests/HTML the route must
    // never serve) — see routes/blob.ts. A re-upload of the same bytes is a no-op.
    await meta.createAsset({
      hash: key,
      org_id: org,
      content_type: type,
      size_bytes: bytes.byteLength,
      width: size?.width ?? null,
      height: size?.height ?? null,
    })
    const url = `${deps.baseUrl.replace(/\/$/, "")}/blob/${key}.${EXT_FOR_TYPE[type]}`
    return {
      key,
      url,
      ref: `asset:${key}`,
      type,
      size: bytes.byteLength,
      ...(size ? { width: size.width, height: size.height } : {}),
      cost: assetCostNote(bytes.byteLength, size),
    }
  }

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/assets",
      tags: ["Assets"],
      summary:
        "Stage a binary asset (image or web font) and get a permanent URL + its asset:<hash> handle.",
      responses: {
        200: {
          description: "The stored asset's public URL and content-addressed handle.",
          content: { "application/json": { schema: AssetRef } },
        },
      },
    }),
    async (c) => {
      // Anyone who can publish to their workspace can stage an asset for it. (The
      // anonymous write-lockdown already blocks unauthenticated POSTs.)
      const org = await requireWorkspace(c, "publish")
      if (org instanceof Response) return bail(org)
      const r = await storeAsset(c, org)
      return r instanceof Response ? bail(r) : c.json(r)
    },
  )

  // The tokened entry point: same upload, but the proof of workspace is a
  // short-lived signed capability in the path instead of a session/bearer. Minted
  // by the MCP `stage_asset` tool for agents whose only credential lives inside
  // the MCP transport (hosted OAuth) — their shell can curl this URL with raw
  // bytes, keeping binaries out of the model's context. The token is
  // workspace-scoped and expiring; what it can write is bounded exactly like the
  // authed route above (sniffed formats, size cap, storage quota).
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/assets/t/{token}",
      tags: ["Assets"],
      summary: "Stage a binary asset with a short-lived upload token (minted over MCP).",
      request: { params: z.object({ token: z.string() }) },
      responses: {
        200: {
          description: "The stored asset's public URL and content-addressed handle.",
          content: { "application/json": { schema: AssetRef } },
        },
      },
    }),
    async (c) => {
      const secret = deps.encryptionKey
      const claim = secret
        ? await verifyUploadToken(secret, c.req.param("token"), Date.now())
        : null
      if (!claim) return bail(fail(c, 403, "invalid or expired upload token"))
      // The token names the user whose grant minted it; re-check their LIVE
      // membership so revocation works mid-TTL — demote or remove the person and
      // their outstanding upload URLs die with the next request, exactly like the
      // per-request role check on the authed route above. (Empty = an ownerless
      // legacy agent; the mint-time role check is all there is for those.)
      if (claim.userId) {
        const m = await meta.getMembership(claim.orgId, claim.userId)
        if (!m || !roleAllows(m.role, "publish"))
          return bail(fail(c, 403, "invalid or expired upload token"))
      }
      const r = await storeAsset(c, claim.orgId)
      return r instanceof Response ? bail(r) : c.json(r)
    },
  )

  return app
}
