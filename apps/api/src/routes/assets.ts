import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { BlankEnv } from "hono/types"
import type { AppContext } from "../context"
import { bail, fail } from "../lib/http"
import { MAX_ASSET_BYTES, sniffImageType } from "../lib/image"

/**
 * Standalone binary assets for bundles. An agent uploads the raw bytes of a
 * screenshot here (a plain binary POST — no base64 transcription), gets back a
 * content-addressed `asset:<hash>` handle, and references that handle in a `publish`
 * `files` map (resolved by decodeBundleFiles). This is the images-without-base64 path:
 * the transport that can't carry megabytes of binary in a JSON tool call streams them
 * as bytes instead, and the tiny handle rides the publish.
 *
 * Bytes are stored content-addressed (identical bytes dedup to one blob) but not yet
 * attached to any version — the storage quota only counts them once a publish
 * references them, so an unused upload costs nothing.
 */
export const assetRoutes = (ctx: AppContext) => {
  const { blobs, workspaceCan, activeWorkspace, overStorage } = ctx
  // Contract-first: the *request* is a raw/multipart binary upload (read by hand
  // below, no JSON body schema), but the *response* is a typed handle that agents /
  // the CLI / MCP consume — so it gets a schema like every other JSON response.
  const app = new OpenAPIHono<BlankEnv>()

  // The content-addressed handle: `key` is the blob hash, `ref` is the exact
  // `asset:<hash>` string to drop into a publish `files` value, `type` is the sniffed
  // image MIME (the closed ImageType set), `size` the byte length.
  const AssetRef = z
    .object({
      key: z.string(),
      ref: z.string(),
      type: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
      size: z.number(),
    })
    .openapi("AssetRef")

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/assets",
      tags: ["Assets"],
      summary: "Stage a binary image asset (raw or multipart) and get its asset:<hash> handle.",
      responses: {
        200: {
          description: "The stored asset's content-addressed handle.",
          content: { "application/json": { schema: AssetRef } },
        },
      },
    }),
    async (c) => {
      // Anyone who can publish to their workspace can stage an asset for it. (The
      // anonymous write-lockdown already blocks unauthenticated POSTs.)
      if (!(await workspaceCan(c, "publish"))) return bail(fail(c, 403, "forbidden"))

      const declared = Number(c.req.header("content-length") ?? 0)
      if (declared > MAX_ASSET_BYTES + 4096) return bail(fail(c, 413, "asset too large (max 25MB)"))

      // Accept either a multipart `file` field (browsers, the CLI's FormData) or a raw
      // binary body (curl --data-binary @shot.png), so an agent can stream bytes the
      // simplest way it has.
      const contentType = c.req.header("content-type") ?? ""
      let bytes: Uint8Array
      if (contentType.includes("multipart/form-data")) {
        const file = (await c.req.parseBody()).file
        if (!(file instanceof File)) return bail(fail(c, 400, "multipart field 'file' required"))
        bytes = new Uint8Array(await file.arrayBuffer())
      } else {
        bytes = new Uint8Array(await c.req.arrayBuffer())
      }

      if (bytes.byteLength === 0) return bail(fail(c, 400, "empty asset body"))
      if (bytes.byteLength > MAX_ASSET_BYTES)
        return bail(fail(c, 413, "asset too large (max 25MB)"))

      // Trust the bytes, not the declared type — and only store a plain raster image (no
      // SVG: served from our origin it could carry script), mirroring the avatar path.
      const type = sniffImageType(bytes)
      if (!type) return bail(fail(c, 400, "unsupported asset (use PNG, JPEG, GIF, or WebP)"))

      const org = await activeWorkspace(c)
      if (await overStorage(org, bytes.byteLength))
        return bail(fail(c, 413, "storage quota exceeded"))

      const key = await blobs.put(bytes)
      // `ref` is the exact string to drop into a publish `files` value.
      return c.json({ key, ref: `asset:${key}`, type, size: bytes.byteLength })
    },
  )

  return app
}
