import { type Action, capRole, roleAllows } from "@derive/core"
import { z } from "zod"
import {
  API_TOKEN_ACCESS,
  API_TOKEN_TTL_MS,
  type ApiTokenAccess,
  roleForAccess,
  signApiToken,
} from "../lib/api-token"
import { MAX_UPLOAD_BYTES } from "../lib/http"
import { MAX_ASSET_BYTES } from "../lib/image"
import { badChoice } from "../lib/open-choice"
import { PUBLISH_TARGET_CREATE, PUBLISH_TOKEN_TTL_MS, signPublishToken } from "../lib/publish-token"
import { scopeGapMessage } from "../lib/scope-gap"
import { signUploadToken, UPLOAD_TOKEN_TTL_MS } from "../lib/upload-token"
import type { ToolContext } from "../mcp-tool-context"
import { err, json } from "../mcp-util"

/** The stage targets. A growth point — see lib/open-choice.ts for why it isn't an enum. */
const STAGE_TARGETS = ["doc", "asset", "api"] as const

/** The capability each access level must actually pass to be mintable. */
const ACCESS_ACTION: Record<ApiTokenAccess, Action> = {
  read: "read",
  comment: "comment",
  publish: "publish",
  manage: "manage",
}
export function registerStageTool(tc: ToolContext): void {
  const {
    server,
    ctx,
    ownerId,
    clientId,
    mintedToken,
    scopeForCap,
    registered,
    reach,
    notFound,
    resolveWs,
    wsArg,
  } = tc

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
        "Mint a SHORT-LIVED capability and curl with it — zero bytes through context. target:'doc' a document/bundle past ~a page, 'asset' an image or font (max 25MB), 'api' a REAL bearer for REST (15 min, capped at your role, live in this transcript). NEVER base64 a binary through a tool call. See derive://skills/publishing.",
      inputSchema: {
        // A STRING, not an enum, on purpose: this discriminator grows (api was added
        // after doc/asset), and a cached client validates an enum locally — so a new
        // value would be unreachable until every connection reconnected. See
        // lib/open-choice.ts. Values live in the description and are checked below.
        target: z
          .string()
          .describe(
            "doc: a document/bundle too big to inline. asset: an image or font a doc embeds. api: a short-lived bearer for REST from your shell.",
          ),
        short_id: z
          .string()
          .optional()
          .describe("target:'doc': revise THIS artifact; omit to create a new one."),
        access: z
          .enum(API_TOKEN_ACCESS)
          .optional()
          .describe(
            "target:'api': narrow the minted token below what this connection holds (least privilege).",
          ),
        workspace: wsArg,
      },
    },
    async ({ target, short_id, access, workspace }) => {
      const wrong = badChoice("target", target, STAGE_TARGETS)
      if (wrong) return err(wrong)
      const t = await resolveWs(workspace)
      if ("error" in t) return err(t.error)
      // `access` shapes a minted token and nothing else. Silently ignoring it on the
      // upload targets would let a caller believe they had narrowed something they
      // hadn't — the same reason `short_id` is rejected rather than dropped.
      if (access && target !== "api")
        return err(`\`access\` applies only to target:'api'. Omit it for target:'${target}'.`)

      if (target === "api") {
        // The general case of what the other two targets do narrowly: this connection is
        // authenticated, but only INSIDE this transport — so mint that same authentication
        // as a spendable bearer for the shell. Least privilege by construction: capped at
        // the role this grant already acts with here, further narrowed by `access`, bound to
        // ONE workspace, minutes long, and re-checked against live membership on every spend.
        if (short_id)
          return err("`short_id` applies only to target:'doc'. Omit it for target:'api'.")
        // Only a transport-bound credential needs this. A REGISTERED dk_agt_ token (and
        // the static operator bearer) is already a string its holder can curl with, so
        // minting from one converts a long-lived credential into a differently-shaped
        // one for no gain — and every credential shape that exists is one more to reason
        // about. Refused for the same reason it isn't needed.
        if (registered || !ownerId)
          return err(
            "stage target:'api' exists to move a credential that only lives inside this MCP transport out to your shell. This connection already holds a shell-usable bearer (dk_agt_/DERIVE_TOKEN) — use that directly.",
          )
        // No chaining: a minted token minting its successor would refresh its own TTL
        // indefinitely, quietly turning "expires in minutes" into "lives forever" — the
        // one property that makes a leaked token a bounded liability. Mint from the grant.
        if (mintedToken)
          return err(
            "This connection is already using a minted API token, which can't mint another (that would let it renew itself indefinitely). Mint from the original MCP connection instead.",
          )
        const secret = ctx.deps.encryptionKey
        if (!secret)
          return err(
            "This server has no signing secret configured, so it can't mint API tokens. Use a bearer token directly instead (DERIVE_TOKEN, or `derive login`).",
          )
        // Ceiling: the role this grant holds in the target workspace (itself already
        // scope-capped AND membership-capped upstream). `access` may only NARROW it —
        // asking for more is refused, naming whether the scope or the seat is short,
        // rather than silently minting something weaker than the caller asked for.
        if (access && !roleAllows(t.role, ACCESS_ACTION[access])) {
          // The RAW membership, not t.role — t.role is already capped BY the scope, so
          // passing it would report a seat gap on every scope gap and send the caller to
          // an admin who has nothing to fix. Read only on this refusal path.
          const seat = await ctx.meta.getMembership(t.org, ownerId).catch(() => null)
          return err(
            scopeGapMessage({
              action: ACCESS_ACTION[access],
              scopeRole: scopeForCap,
              memberRole: seat?.role ?? t.role,
              registered,
              baseUrl: ctx.deps.baseUrl,
            }) ??
              `This connection can't mint a "${access}" token here — it acts as ${t.role} in this workspace.`,
          )
        }
        const role = capRole(access ? roleForAccess[access] : t.role, t.role)
        const expiresAt = Date.now() + API_TOKEN_TTL_MS
        const tok = await signApiToken(secret, ownerId, t.org, role, clientId, expiresAt)
        const base = ctx.deps.baseUrl.replace(/\/$/, "")
        return json({
          target: "api",
          token: tok,
          workspace: t.org,
          acts_as: role,
          expires_in_minutes: Math.round(API_TOKEN_TTL_MS / 60_000),
          base_url: base,
          how:
            `curl -sS -H "Authorization: Bearer ${tok}" "${base}/v1/artifacts?limit=1". ` +
            `Spend it against any REST route this role can reach. Its workspace SEAT is ${t.org} alone. ` +
            "It expires on its own and is not refreshable — mint another when it lapses.",
          // Precise about the bound, because an overstated one is worse than none: the
          // SEAT is a single workspace, but a link-shared artifact grants its own role to
          // whoever holds the link, and that is not capped by this token's role — the
          // same as any other credential this human holds. `access` narrows the seat, not
          // the link.
          note: "A real credential: it is not redacted from this transcript, so treat it like one. It carries one workspace seat, one role, for minutes, and removing the user from that workspace kills it immediately. It does NOT shrink what link-shared artifacts already grant the holder of their link.",
        })
      }

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
