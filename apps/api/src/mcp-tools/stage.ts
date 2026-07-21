import { roleAllows } from "@derive/core"
import { z } from "zod"
import { MAX_UPLOAD_BYTES } from "../lib/http"
import { MAX_ASSET_BYTES } from "../lib/image"
import { PUBLISH_TARGET_CREATE, PUBLISH_TOKEN_TTL_MS, signPublishToken } from "../lib/publish-token"
import { signUploadToken, UPLOAD_TOKEN_TTL_MS } from "../lib/upload-token"
import type { ToolContext } from "../mcp-tool-context"
import { err, json } from "../mcp-util"

export function registerStageTool(tc: ToolContext): void {
  const { server, ctx, ownerId, reach, notFound, resolveWs, wsArg } = tc

  // STAGE — one tool, two out-of-band upload URLs, each spent with curl so bytes never
  // enter the model's context. target:'asset' = the former stage_asset (a binary a doc
  // embeds); target:'doc' = the former stage_publish (a whole big document/bundle). The
  // blessed paths are POST /v1/assets and POST /v1/artifacts, but a hosted-OAuth
  // connection's credential lives inside this transport — the shell has no bearer to curl
  // with — so these mint short-lived signed URLs that need none. The doc path is scoped
  // tighter because publishing writes artifacts (see lib/publish-token.ts).
  server.registerTool(
    "stage",
    {
      description:
        "Upload out-of-band — mint a SHORT-LIVED, no-bearer upload URL, then curl the file's bytes to it from your shell (zero tokens through context). target:'doc' for a whole big document or bundle more than ~a page (returns a publish URL — curl the file, or a zipped dir which becomes a bundle; omit short_id to CREATE, pass it to REVISE that exact target; read derive://skills/publishing). target:'asset' for an image or font a document EMBEDS (returns a permanent url for single-file content + an asset:<hash> ref for a bundle `files` map; raster images and WOFF/WOFF2 only, max 25MB; read derive://skills/assets). Staging alone does not publish an artifact. NEVER base64 a binary through a tool call — a pasted image is already a file on disk.",
      inputSchema: {
        target: z
          .enum(["doc", "asset"])
          .describe(
            "doc: a whole document/bundle too big to inline (returns a publish URL). asset: an image or font a doc embeds (returns a permanent asset url + ref).",
          ),
        short_id: z
          .string()
          .optional()
          .describe(
            "target:'doc' ONLY — revise THIS artifact; omit to create a new one (the token is scoped to it). Rejected with target:'asset' (an asset isn't versioned).",
          ),
        workspace: wsArg,
      },
    },
    async ({ target, short_id, workspace }) => {
      const t = await resolveWs(workspace)
      if ("error" in t) return err(t.error)

      if (target === "asset") {
        // A binary an embedding doc references — the former stage_asset path, verbatim.
        if (short_id)
          return err("`short_id` applies only to target:'doc'. An asset isn't versioned — omit it.")
        // Same bar as POST /v1/assets itself: staging is a publish-side capability.
        if (!roleAllows(t.role, "publish"))
          return err("Your role in this workspace can't stage assets (publishing required).")
        const secret = ctx.deps.encryptionKey
        if (!secret)
          return err(
            "This server has no signing secret configured, so it can't mint upload URLs. POST the bytes to /v1/assets with a bearer token instead (DERIVE_TOKEN, or `derive login`).",
          )
        // Bind the token to the granting user so the spend side can re-check live
        // membership — revoking or demoting them kills outstanding URLs mid-TTL.
        // An ownerless legacy agent has no user to bind; it mints an unbound token.
        const expiresAt = Date.now() + UPLOAD_TOKEN_TTL_MS
        const tok = await signUploadToken(secret, t.org, ownerId ?? "", expiresAt)
        const uploadUrl = `${ctx.deps.baseUrl.replace(/\/$/, "")}/v1/assets/t/${tok}`
        return json({
          target: "asset",
          upload_url: uploadUrl,
          workspace: t.org,
          expires_in_minutes: Math.round(UPLOAD_TOKEN_TTL_MS / 60_000),
          max_bytes: MAX_ASSET_BYTES,
          accepts: [
            "image/png",
            "image/jpeg",
            "image/gif",
            "image/webp",
            "font/woff",
            "font/woff2",
          ],
          how: `curl -sS -X POST --data-binary @<file> "${uploadUrl}" → {url, ref, ...}. Paste \`url\` into content, or use \`ref\` ("asset:<hash>") as a bundle files value. Repeat for each file until expiry.`,
        })
      }

      // target === "doc" — a whole document/bundle, the former stage_publish path, verbatim.
      // A publish is attributed to a person and its URL is re-checked against their live
      // rights — so it needs a known granting user. A static agent token (dk_agt_/
      // DERIVE_TOKEN) has none, but it also isn't trapped in this transport: it can POST
      // to /v1/artifacts with that bearer directly.
      if (!ownerId)
        return err(
          "stage target:'doc' needs a signed-in user to attribute the publish to. With a static agent token, POST to /v1/artifacts with that token in the Authorization header instead.",
        )
      const secret = ctx.deps.encryptionKey
      if (!secret)
        return err(
          "This server has no signing secret configured, so it can't mint publish URLs. POST to /v1/artifacts with a bearer token instead (DERIVE_TOKEN, or `derive login`).",
        )
      // The workspace the token is minted for. For a REVISE it must be the artifact's
      // ACTUAL workspace — reach() may auto-roam a bare short_id to another workspace in
      // the grant, and the spend-side org guard would 403 a token minted against default.
      let org = t.org
      if (short_id) {
        const reached = await reach(short_id, workspace)
        if (reached && "error" in reached) return err(reached.error)
        if (!reached) return notFound(short_id)
        org = reached.org
        // Revising needs artifact-level publish STANDING (share + seat), the same right
        // the spend-side re-checks — not the workspace seat role, which on a private
        // artifact grants nothing. Fail at mint for a clear message.
        if (!(await ctx.authorizeUserStanding(ownerId, "publish", reached.a)))
          return err("You don't have permission to publish a new version of that artifact.")
      } else if (!roleAllows(t.role, "publish")) {
        // Creating is a workspace-level right.
        return err("Your role in this workspace can't publish (publishing required).")
      }
      const expiresAt = Date.now() + PUBLISH_TOKEN_TTL_MS
      const targetName = short_id ?? PUBLISH_TARGET_CREATE
      const tok = await signPublishToken(secret, org, ownerId, targetName, expiresAt)
      const base = ctx.deps.baseUrl.replace(/\/$/, "")
      const uploadUrl = short_id
        ? `${base}/v1/artifacts/${short_id}/versions/t/${tok}`
        : `${base}/v1/artifacts/t/${tok}`
      return json({
        target: "doc",
        upload_url: uploadUrl,
        workspace: org,
        mode: short_id ? `revise ${short_id}` : "create",
        expires_in_minutes: Math.round(PUBLISH_TOKEN_TTL_MS / 60_000),
        max_bytes: MAX_UPLOAD_BYTES,
        how: `Single file: curl -sS -F file=@<path> ${short_id ? "" : "-F title='<title>' "}"${uploadUrl}". Bundle: zip the dir (zip -r /tmp/b.zip .) then curl -sS -F file=@/tmp/b.zip "${uploadUrl}" — a .zip becomes a multi-page bundle. Returns the artifact {short_id, url, ...}.`,
      })
    },
  )
}
