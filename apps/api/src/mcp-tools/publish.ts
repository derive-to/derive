import {
  type AnyDocEdit,
  artifactUrl,
  assertedOnly,
  bundleFactsAdvisory,
  EditError,
  heavyAssetsAdvisory,
  LINKED_BUNDLE_CONTENT_TYPE,
  LINKED_BUNDLE_FACT,
  looksLikeHtmlDocument,
  missingBlobAdvisory,
  newId,
  PublishError,
  parseTemplateLibraryUri,
  publishAdvisories,
  publish as publishVersion,
  type Role,
  roleAllows,
  slotShapeDriftAdvisories,
  TEMPLATE_LIBRARY_CATALOG_URI,
} from "@derive/core"
import { z } from "zod"
import { PROFILE_PLACEHOLDER_HTML } from "../brandprint-reference"
import { afterPublish } from "../lib/after-publish"
import { AGENT_WRITES_OFF, agentWritesOff } from "../lib/agent-writes"
import { cleanPath, mergeBundleZip, zipBundleFiles } from "../lib/bundle"
import {
  collectRender,
  RENDER_VARIANTS,
  RENDER_WAIT_MAX,
  type RenderVariant,
  rendersOff,
} from "../lib/collect-render"
import {
  type MaterializedEdits,
  materializeEdits,
  materializeSlideOps,
  preservingFilename,
} from "../lib/edits"
import { MAX_UPLOAD_BYTES } from "../lib/http"
import { badChoice, choiceDescription } from "../lib/open-choice"
import { agentPushFanout, openReviewRound } from "../lib/review-request"
import { normalizeTags } from "../lib/tags"
import { canReadTemplateLibrary } from "../lib/template-library-access"
import type { ToolContext } from "../mcp-tool-context"
import {
  err,
  IMAGE_INLINE_MAX,
  json,
  largestInlineDataUriBytes,
  MAX_INLINE_CONTENT_BYTES,
  MAX_INLINE_DATA_URI_BYTES,
  manifestOf,
  text,
  toBase64,
} from "../mcp-util"

export function registerPublishTool(tc: ToolContext): void {
  // NOTE: the surface deliberately does NOT vary by scope. Hiding publish's live-only access
  // params from a grant that can only comment was built, measured (197 tokens, 4.1%) and
  // REVERTED: derive://skills/publishing names `workspace_access`, `link_role`, `listed` and
  // `request_review` outright, and skills are static, so a gated connection reads a procedure
  // naming params its schema does not contain. That is the same contradiction that stopped
  // tool-level gating one commit earlier. It also bought nothing where it matters — a
  // publishing agent, the connection doing real work, saw every param either way.
  const {
    server,
    ctx,
    agent,
    actingFor,
    ownerId,
    defaultOrg,
    defaultRole,
    reach,
    inGrant,
    resolveWs,
    wsArg,
    clientId,
  } = tc
  // The ATTENDED surfaces run this same tool in-process with the asker as `actingFor`. For
  // them the person behind the write is sitting in the conversation — a review round is the
  // record, not an interrupt — where a detached executor's whole point is interrupting the
  // human it acts for.
  const attended = clientId === "chat"

  // Resolve derive://brandprint/profile to the workspace's brand-profile artifact,
  // scaffolding it (conventions collection + "Brand profile" placeholder + settings
  // pointer) on first use. This is the former setup_brandprint, folded in so the brand
  // profile is a publish TARGET rather than a separate tool. INVARIANT (critical safety):
  // the scaffold's WRITES fire ONLY when the caller holds `manage` (Owner/Admin); a
  // non-manage caller for whom nothing is set up yet gets an actionable error naming an
  // Admin, and NO write happens. Reusing an already-set-up profile needs no manage (a
  // normal revision). Body copied verbatim from setup_brandprint.
  const resolveBrandprintProfileTarget = async (
    targetOrg: string,
    role: Role,
    uid: string,
  ): Promise<{ profileShortId: string } | { error: string }> => {
    const settings = await ctx.meta.getOrgSettings(targetOrg)
    const bp = settings.brandprint
    // Reuse an in-tenant profile pointer if one exists — no scaffold, so no manage gate.
    let profileShortId = bp?.profileId
    if (profileShortId) {
      const art = await ctx.meta.getByShortId(profileShortId)
      if (!(art && art.org_id === targetOrg)) profileShortId = undefined
    }
    if (profileShortId) return { profileShortId }

    // Nothing set up yet ⇒ SCAFFOLD, which writes. Owner/Admin only — the gate is BEFORE
    // any create/publish, so a non-manage caller leaves the workspace untouched.
    if (!roleAllows(role, "manage"))
      return {
        error:
          "This workspace has no Brandprint profile yet, and only an Admin/Owner can set one up. Ask an Admin to publish to derive://brandprint/profile once (that scaffolds it); after that anyone with publish rights can revise it.",
      }
    // The scaffold below is a real live write (a collection create + a placeholder
    // publish). The profile's own revision is a live write too now, gated at the shared
    // billing check on the publish path; this earlier check exists so a billing-blocked
    // workspace refuses the scaffold BEFORE any of it writes.
    const blocked = await ctx.billingBlocked(targetOrg)
    if (blocked) return { error: blocked.message }
    // Reuse an in-tenant collection pointer; otherwise create the conventions collection
    // (workspace-open so teammates read the docs + the reveal).
    let collectionId = bp?.collectionId
    if (collectionId) {
      const col = await ctx.meta.getCollection(collectionId)
      if (!col || col.org_id !== targetOrg) collectionId = undefined
    }
    if (!collectionId) {
      const col = await ctx.meta.createCollection({
        id: newId("col"),
        org_id: targetOrg,
        title: "Brandprint",
        created_by: uid,
        workspace_access: "member",
      })
      await ctx.meta.setCollectionMember({
        id: newId("cm"),
        collection_id: col.id,
        user_id: uid,
        role: "owner",
      })
      collectionId = col.id
    }
    // Publish the placeholder (v1 stub) into the collection. Deliberately UNstamped: this
    // auto-scaffolded placeholder is not the user's "first agent publish" — stamping 'mcp'
    // here would flip the onboarding signal (and welcome celebration) on an empty stub.
    const { artifact } = await publishVersion(ctx.meta, ctx.blobs, {
      bytes: new TextEncoder().encode(PROFILE_PLACEHOLDER_HTML),
      filename: "Brand profile.html",
      isBundle: false,
      title: "Brand profile",
      message: "Brand profile placeholder — your agent fills this in.",
      author: agent.name,
      authorId: uid,
      orgId: targetOrg,
      workspaceAccess: "member",
      linkRole: "none",
      listed: "none",
    })
    await ctx.meta.addCollectionItem(collectionId, artifact.id)
    await ctx.meta.setOrgSettings(targetOrg, {
      ...settings,
      brandprint: { collectionId, profileId: artifact.short_id },
    })
    return { profileShortId: artifact.short_id }
  }

  // WRITE — every publish lands live -------------------------------------------
  server.registerTool(
    "publish",
    {
      description:
        "Publish a document. `short_id` UPDATES, omitting it CREATES (`title` required). ONE payload: `edits` (default for a change — read format:'html' first, each match must be unique), `slide_ops` (rearrange a deck), `content`, or `files`. NEVER inline past ~a page or any image/font — use stage. Publishes LIVE; `request_review` asks for a human look. Bundles: derive://skills/bundles. See derive://skills/publishing.",
      // Additive versioning: a republish creates a new current version and the prior ones
      // stay in history (read short_id, version:N) — nothing is overwritten irreversibly,
      // so not destructive. Not idempotent: calling twice with the same content still
      // creates two versions. Derive's own backend (the email/Slack
      // review-request DM is a side notification, not the tool's domain).
      annotations: {
        title: "Publish an artifact",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        content: z
          .string()
          .optional()
          .describe(
            "The complete content for a SINGLE-FILE artifact. Embed images/fonts by their staged permanent url, never a base64 data: URI. Stage anything large instead of inlining it.",
          ),
        files: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            "A MULTI-PAGE bundle: path → content. Values are text pages, or an \"asset:<hash>\" ref from stage target:'asset' for images/fonts. Root index.html is the entry page. A plain republish REPLACES the bundle — include every file, or use `merge`.",
          ),
        title: z.string().optional(),
        short_id: z.string().optional(),
        workspace_access: z
          .enum(["none", "member"])
          .optional()
          .describe(
            "Do this workspace's members reach a NEW artifact, each at their seat role: member (default) or none (invite-only). Ignored on republish.",
          ),
        link_role: z
          .enum(["none", "viewer", "commenter", "editor"])
          .optional()
          .describe(
            "What merely holding a NEW artifact's URL confers on ANYONE, including outside the workspace: none (default) | viewer | commenter | editor. Anonymous holders clamp to viewer. Ignored on republish.",
          ),
        listed: z
          .enum(["none", "workspace", "public"])
          .optional()
          .describe(
            "Where a NEW artifact surfaces for discovery (no access of its own): none (default) | workspace (needs workspace_access=member) | public (needs a link_role). Ignored on republish.",
          ),
        spa: z
          .boolean()
          .optional()
          .describe("NEW bundle only: serve unknown paths from the entry page (SPA routing)."),
        merge: z
          .boolean()
          .optional()
          .describe(
            "Add/overwrite `files` INTO the existing bundle instead of replacing it. Requires `short_id`.",
          ),
        message: z.string().optional(),
        derived_from: z
          .string()
          .regex(
            /^(?:[0-9a-z]{6,12}|derive:\/\/template-libraries\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+)$/,
          )
          .optional()
          .describe(
            "NEW artifact only: preserve lineage to an artifact short id or the exact derive://template-libraries/<library>/<entry> URI you read. Omit on revisions.",
          ),
        tags: z
          .array(z.string())
          .optional()
          .describe(
            "Workspace-wide labels that make it findable; reuse an existing tag over a near-duplicate. REPLACES the set (trimmed, lowercased, deduped, capped 20); [] clears; omitted leaves them untouched.",
          ),
        filename: z.string().optional(),
        addresses: z
          .array(z.string())
          .optional()
          .describe("Thread ids (from catch_up) this revision resolves."),
        request_review: z
          .boolean()
          .optional()
          .describe(
            "After a LIVE publish, ask your human to review this version — the /derive loop.",
          ),
        // SEE IT in the same call. Optional and off by default, so an existing caller's
        // response shape never changes.
        render: z
          .string()
          .optional()
          .describe(
            choiceDescription(
              RENDER_VARIANTS,
              "Return a screenshot with this response instead of a second read.",
            ),
          ),
        // COERCED, not bare `z.number()`. A client caches the tool schema at connect, so a
        // parameter added afterwards has no type for it to coerce against and the value
        // arrives as a string — the server then rejects it, and the capability is exactly
        // as unreachable as a new enum value used to be. Found by using it: `render` (a
        // string) passed through while `wait` did not, so the render could be requested
        // and never waited for. See scripts/check-mcp-coercion.mjs.
        wait: z.coerce
          .number()
          .optional()
          .describe(
            `With \`render\`: block up to this many seconds (max ${RENDER_WAIT_MAX}) for the shot. Omit and you get the ordinary response if it isn't ready yet.`,
          ),
        workspace: wsArg,
        edits: z
          .array(
            z.union([
              z.object({
                old_str: z
                  .string()
                  .describe(
                    "Exact text from the STORED SOURCE (read format:'html' first). Must occur exactly once unless `occurrence` picks one.",
                  ),
                new_str: z.string().describe("Replacement text. Empty string deletes."),
                occurrence: z.coerce
                  .number()
                  .optional()
                  .describe(
                    "1-based index of which match to replace, when old_str is intentionally non-unique.",
                  ),
              }),
              z.object({
                quote: z
                  .object({
                    exact: z.string().describe("The VISIBLE text to replace, as a reader sees it."),
                    prefix: z.string().optional().describe("Visible text just before it."),
                    suffix: z.string().optional().describe("Visible text just after it."),
                  })
                  .describe(
                    "Locates the edit by RENDERED text instead of raw source. The context must pin exactly one spot, and the span may not cross markup.",
                  ),
                new_text: z
                  .string()
                  .describe("Replacement for the quoted span, as plain text. Empty deletes."),
              }),
              z.object({
                schema: z.literal("derive.structural-edit/v1"),
                op: z.enum(["structural-size", "structural-order", "structural-remove"]),
                region: z.string(),
                node: z.string().optional(),
                nodes: z.array(z.string()).optional(),
                size: z.enum(["compact", "standard", "full"]).nullable().optional(),
              }),
              z.object({
                op: z.literal("scene-update"),
                id: z.string().describe("Stable data-derive-scene value."),
                duration_ms: z.coerce.number().optional(),
                transition: z.enum(["cut", "fade", "dissolve", "slide"]).optional(),
                transition_ms: z.coerce.number().optional(),
                caption: z.string().max(500).optional(),
              }),
              z.object({
                op: z.literal("scene-move"),
                id: z.string().describe("Stable data-derive-scene value."),
                direction: z.enum(["previous", "next"]),
              }),
              z.object({
                op: z.literal("scene-duplicate"),
                id: z.string().describe("Stable data-derive-scene value."),
              }),
              z.object({
                op: z.literal("scene-delete"),
                id: z.string().describe("Stable data-derive-scene value."),
              }),
            ]),
          )
          .optional()
          .describe(
            "Revise one file with exact-source, visible-text, structural element, or video-scene edits. Safe legacy decks gain structural IDs on first inline save.",
          )
          // WORKED EXAMPLES, not more prose. This param accepts multiple object shapes behind a
          // union, and a schema can say what is legal without showing which one a given job
          // wants — the gap examples exist to close. One per shape an agent actually reaches
          // for: raw-source replace, visible-text replace, and a scene op. The array nesting
          // is half the point; the first mistake is passing a bare object.
          .meta({
            examples: [
              [{ old_str: "<h1>Old title</h1>", new_str: "<h1>New title</h1>" }],
              [
                {
                  quote: { exact: "4,000 events/sec", prefix: "throughput is " },
                  new_text: "6,200 events/sec",
                },
              ],
              [
                {
                  schema: "derive.structural-edit/v1",
                  op: "structural-order",
                  region: "slide-2",
                  nodes: ["slide-2-node-2", "slide-2-node-1"],
                },
              ],
              [{ op: "scene-update", id: "intro", duration_ms: 4000, transition: "fade" }],
            ],
          }),
        slide_ops: z
          .array(
            z.union([
              z.object({
                op: z.literal("move"),
                from: z.coerce.number().describe("1-based position of the slide to move."),
                to: z.coerce.number().describe("1-based position it should end up at."),
              }),
              z.object({
                op: z.literal("delete"),
                at: z.coerce.number().describe("1-based position of the slide to remove."),
              }),
              z.object({
                op: z.literal("duplicate"),
                at: z.coerce.number().describe("1-based position of the slide to copy."),
              }),
              z.object({
                op: z.literal("insert"),
                at: z.coerce
                  .number()
                  .describe("1-based position for a new blank slide (may be one past the end)."),
              }),
            ]),
          )
          .optional()
          .describe(
            "Rearrange a DECK: move / delete / duplicate / insert whole slides by 1-based position, applied in order. Use instead of `edits` for structural changes. Ambiguous structure refuses the whole batch.",
          ),
        base_version: z.coerce
          .number()
          .optional()
          .describe("Version read; fails if the artifact has moved."),
      },
    },
    async ({
      content: contentIn,
      files,
      title,
      short_id,
      workspace_access,
      link_role,
      listed,
      spa,
      merge,
      message,
      derived_from,
      tags,
      filename,
      addresses,
      request_review,
      render,
      wait,
      workspace,
      edits,
      slide_ops,
      base_version,
    }) => {
      // BEFORE anything is written. Validating this after the publish committed meant a
      // near-miss variant ("screenshot", "png") returned isError on an artifact that was
      // already live — and the obvious retry then created a SECOND one. Argument checks
      // belong ahead of the mutation, which is where organize does its equivalent.
      if (render) {
        const wrongRender = badChoice("render", render, RENDER_VARIANTS)
        if (wrongRender) return err(wrongRender)
      }
      let content = contentIn
      const BP = "derive://brandprint/"
      // The brand profile publishes LIVE like any document, but ALWAYS opens a review
      // round: it steers every agent in the workspace, so the person is told the moment
      // it changes (and restore is one click). Also its exemption from the total-inline
      // cap below (it has no out-of-band path to its URI). Computed from the RAW target,
      // before resolution.
      const isProfileTarget = short_id === `${BP}profile`

      // GUARDRAILS — reject inline payloads that belong out-of-band, BEFORE any write or
      // scaffold, naming the `stage` mode to use. (a) A single base64 data: URI past ~32KB
      // is a binary pasted through the call — stage it as an asset. (b) Total inline
      // content/files past ~64KB is a whole big document — curl it via stage target:'doc'.
      // `edits` publishes carry neither content nor files, so they never trip these; the
      // brand profile is exempt from the total-size cap but still may not smuggle an
      // oversized binary inline.
      const inlineStrings: string[] = []
      if (typeof contentIn === "string") inlineStrings.push(contentIn)
      if (files) inlineStrings.push(...Object.values(files))
      if (inlineStrings.length) {
        const biggestDataUri = Math.max(0, ...inlineStrings.map(largestInlineDataUriBytes))
        if (biggestDataUri > MAX_INLINE_DATA_URI_BYTES)
          return err(
            `An inline base64 data: URI is ~${Math.round(biggestDataUri / 1024)}KB — too big to carry through a tool call. Upload the binary with stage target:'asset' and reference the returned url/ref instead (a pasted image is already a file on disk).`,
          )
        const totalBytes = inlineStrings.reduce((n, s) => n + new TextEncoder().encode(s).length, 0)
        if (!isProfileTarget && totalBytes > MAX_INLINE_CONTENT_BYTES)
          return err(
            `This inline payload is ~${Math.round(totalBytes / 1024)}KB — past the ~${Math.round(
              MAX_INLINE_CONTENT_BYTES / 1024,
            )}KB inline ceiling. Push the whole document/bundle with stage target:'doc' (curl the file, or a zipped dir for a bundle) instead of inlining it.`,
          )
      }

      // Resolve a derive:// target — publish accepts the same URI strings `read` does. The
      // only WRITEABLE one is the brand profile; the static build guide and core skills are
      // read-only, and any other derive:// string is rejected rather than silently treated
      // as a short_id. A profile publish always opens a review round (profileAskReview),
      // addressed to the human behind the grant — or the token's registrant when no human
      // is on the call — so the reveal is never silent.
      let profileAskReview = false
      let profileReviewer: string | null = null
      if (short_id?.startsWith("derive://")) {
        if (isProfileTarget) {
          const t = await resolveWs(workspace)
          if ("error" in t) return text(t.error)
          const uid = actingFor?.id ?? ownerId
          if (!uid)
            return err(
              "Publishing the brand profile needs a signed-in user to attribute it to. Connect with an OAuth agent grant rather than a static agent token.",
            )
          // THE AGENT-WRITE SWITCH, checked before the profile SCAFFOLD can write: on an
          // un-scaffolded workspace this resolution creates the conventions collection, the
          // placeholder, and the settings pointer — five writes that must not land while
          // agents are switched off. (The main gate below covers the publish itself; this
          // one covers the resolution's own writes.)
          if (await agentWritesOff(ctx.meta, t.org)) return err(AGENT_WRITES_OFF)
          const resolved = await resolveBrandprintProfileTarget(t.org, t.role, uid)
          if ("error" in resolved) return err(resolved.error)
          short_id = resolved.profileShortId
          profileAskReview = true
          profileReviewer = uid
        } else if (short_id.startsWith(BP)) {
          const seg = short_id.slice(BP.length)
          if (seg === "reference" || seg === "template")
            return err(
              `${short_id} is a read-only build guide — you can't publish to it. Build the profile and publish it to derive://brandprint/profile instead.`,
            )
          // derive://brandprint/<short_id> — a source doc; strip to the bare short_id.
          short_id = seg
        } else if (short_id.startsWith("derive://skills/")) {
          return err("Core skills are read-only — you can't publish to a derive://skills/ URI.")
        } else if (short_id.startsWith("derive://decks/")) {
          return err(
            "The deck starter is read-only — copy it, restyle it, and publish your deck as a new artifact (omit short_id).",
          )
        } else {
          return err(
            `Can't publish to "${short_id}" — the only writeable derive:// target is derive://brandprint/profile.`,
          )
        }
      }
      // Revise an existing artifact wherever it lives (reach roams to its
      // workspace, within the grant); create a new one in the targeted (or
      // default) workspace. The acting role is re-capped to that workspace, so
      // the publish gate is correct there, not just in the default one.
      const reached = short_id ? await reach(short_id, workspace) : null
      if (reached && "error" in reached) return text(reached.error)
      const existing = reached && !("error" in reached) ? reached.a : null
      if (short_id && !existing) return text(`No artifact "${short_id}" you can reach.`)
      if (short_id && derived_from)
        return err("`derived_from` records creation lineage and cannot be added to a revision.")
      let targetOrg = defaultOrg
      let actRole = defaultRole
      if (existing && reached && !("error" in reached)) {
        targetOrg = reached.org
        actRole = reached.role
      } else if (!short_id) {
        const t = await resolveWs(workspace)
        if ("error" in t) return text(t.error)
        targetOrg = t.org
        actRole = t.role
      }

      // THE AGENT-WRITE SWITCH binds every write this tool makes, whichever grant is
      // calling (a standing MCP connection, an agent bearer,
      // the code sandbox) — so "agents stop writing" is true wherever an agent-credentialed
      // write can start. Checked as soon as the target workspace is known, before anything
      // lands a row; one settings read serves the switch and the brand-profile pointer
      // below, and a failed read refuses (null settings), like every reader of the switch.
      const orgSettings = await ctx.meta.getOrgSettings(targetOrg).catch(() => null)
      if (!orgSettings?.agentWrites) return err(AGENT_WRITES_OFF)

      // The profile's forced round holds HOWEVER the profile is addressed. The URI branch
      // above set profileAskReview for `derive://brandprint/profile`; a publish straight to
      // the profile artifact's short_id must not be the silent side door, so the target is
      // re-checked against the workspace's stored pointer.
      if (existing && !profileAskReview) {
        if (orgSettings.brandprint?.profileId === existing.short_id) {
          const uid = actingFor?.id ?? ownerId
          if (!uid)
            return err(
              "Publishing the brand profile needs a signed-in user to attribute it to. Connect with an OAuth agent grant rather than a static agent token.",
            )
          profileAskReview = true
          profileReviewer = uid
        }
      }

      // Creation lineage uses the same access rules as reading the starting
      // point. Library entries are immutable snapshots, so the copy can outlive
      // its source; the stored edge points to that source artifact when present.
      let derivedFromId: string | null = null
      const authoredTemplate = derived_from ? parseTemplateLibraryUri(derived_from) : null
      if (
        derived_from?.startsWith(`${TEMPLATE_LIBRARY_CATALOG_URI}/`) &&
        !authoredTemplate?.entryId
      )
        return err(`No template starter "${derived_from}" you can reach.`)
      if (authoredTemplate?.entryId) {
        const { libraryId, entryId } = authoredTemplate
        const [library, entry] = await Promise.all([
          ctx.meta.getTemplateLibrary(libraryId),
          ctx.meta.getTemplateLibraryEntry(entryId),
        ])
        if (!library || !entry || entry.library_id !== library.id)
          return err(`No template starter "${derived_from}" you can reach.`)
        const uid = actingFor?.id ?? ownerId
        const member = uid ? await ctx.meta.getMembership(library.org_id, uid) : null
        const readable = canReadTemplateLibrary(library, {
          ownerId: uid,
          workspaceReachable: !!uid && inGrant(library.org_id),
          isMember: !!member,
        })
        if (!readable) return err(`No template starter "${derived_from}" you can reach.`)
        derivedFromId = entry.source_artifact_id
      } else if (derived_from) {
        // Lineage needs read reach only, so a public template in another workspace
        // qualifies; the copy itself lands in the target workspace at the caller's role.
        const source = await reach(derived_from, workspace, { public: true })
        if (!source || "error" in source)
          return err(
            source && "error" in source
              ? source.error
              : `No source artifact "${derived_from}" you can reach.`,
          )
        derivedFromId = source.a.id
      }

      // `edits` / `slide_ops` — materialize the full new content up front, then fall
      // through to the untouched publish pipeline (sweep, addresses, receipts
      // all inherit). Text and structure are separate fields because they are separate
      // kinds of intent, and a batch mixing them would have no honest ordering.
      let editsApplied = 0
      let slideOpsApplied = 0
      if (edits !== undefined || slide_ops !== undefined) {
        const field = slide_ops !== undefined ? "slide_ops" : "edits"
        if (edits !== undefined && slide_ops !== undefined)
          return err("Provide `edits` OR `slide_ops`, not both.")
        if (content !== undefined || files)
          return err(`Provide \`${field}\` OR \`content\`/\`files\`, not both.`)
        if (!existing)
          return err(`\`${field}\` revises an EXISTING artifact — pass its \`short_id\`.`)
        const deps = {
          getVersion: ctx.meta.getVersion.bind(ctx.meta),
          sourceText: ctx.sourceText,
        }
        let materialized: MaterializedEdits
        try {
          materialized = slide_ops
            ? await materializeSlideOps(deps, existing, slide_ops, base_version)
            : await materializeEdits(deps, existing, edits as AnyDocEdit[], base_version)
        } catch (e) {
          if (e instanceof EditError) return err(e.message)
          throw e
        }
        // Same size/storage ceiling the REST /versions route applies
        // after materializing edits — without this the MCP tool could write an
        // over-quota version the HTTP surfaces would have rejected.
        const editedBytes = new TextEncoder().encode(materialized.content).length
        if (editedBytes > MAX_UPLOAD_BYTES) return err("Edited content is too large.")
        if (await ctx.overStorage(targetOrg, editedBytes)) return err(ctx.blockCopy.storage.message)
        content = materialized.content
        if (slide_ops) slideOpsApplied = slide_ops.length
        else editsApplied = (edits as AnyDocEdit[]).length
        if (!filename) filename = materialized.filename
      }

      // Exactly one of content / files. `files` (a page map) means a bundle.
      const isBundle = !!files && Object.keys(files).length > 0
      if (isBundle && content !== undefined)
        return text("Provide `content` (single file) OR `files` (a bundle), not both.")
      if (!isBundle && (content === undefined || content === ""))
        return text("Provide `content` (single file), `files` (a multi-page bundle), or `edits`.")
      if (existing) {
        // Kind can't change on republish; steer to the right field instead of the 409.
        if (existing.kind === "bundle" && !isBundle)
          return text(
            `"${short_id}" is a multi-page bundle — pass \`files\` (every page) to republish it.`,
          )
        if (existing.kind === "file" && isBundle)
          return text(`"${short_id}" is a single-file artifact — pass \`content\`, not \`files\`.`)
        // The SAME republish gate the HTTP route enforces (routes/artifacts.ts) — the
        // agent path must never be the one that walks around them.
        if (existing.locked)
          return err(
            `"${short_id}" is locked — leave your suggested change as a comment, or ask an editor to unlock it.`,
          )
      }

      // Publishing needs publish standing — a commenter-grade grant is steered to
      // comments, where its suggestion reaches a person who can apply it.
      if (!roleAllows(actRole, "publish"))
        return text(
          "Your grant can't publish here. Leave your suggested change as a comment on the document instead, and someone with publish rights can apply it.",
        )

      // Billing gates the live write, after the standing check above.
      const blocked = await ctx.billingBlocked(targetOrg)
      if (blocked) return err(blocked.message)
      if (merge) {
        if (!isBundle) return text("`merge` adds files to a bundle — pass `files`, not `content`.")
        if (!existing) return text("`merge` needs the `short_id` of an existing bundle to add to.")
        if (existing.kind !== "bundle")
          return text(
            `"${short_id}" is a single-file artifact — \`merge\` only applies to bundles.`,
          )
      }
      if (!existing && !title?.trim()) return text("Creating a new artifact needs a `title`.")
      try {
        let bytes: Uint8Array
        // A merge keeps the bundle's existing SPA routing (the caller isn't redeclaring it).
        let bundleSpa = isBundle ? !!spa : undefined
        if (!isBundle) {
          bytes = new TextEncoder().encode(content as string)
        } else if (merge && existing) {
          const v = await ctx.meta.getVersion(existing.id, existing.current_version)
          const manifest = v && (await manifestOf(ctx, v))
          if (!manifest)
            return text(`Couldn't read the current bundle for "${short_id}" to merge into.`)
          bytes = await mergeBundleZip(ctx.blobs, manifest, files as Record<string, string>)
          bundleSpa = manifest.spa
        } else {
          bytes = await zipBundleFiles(files as Record<string, string>, ctx.blobs)
        }
        // Access is set-on-create (a republish never re-stamps): each field resolves
        // explicit arg > the TARGETED workspace's default (the default workspace
        // unless a `workspace` was named). The factory default is the "team
        // draft" — workspace_access=member, link_role=none, listed=none: a teammate
        // can open the link, the world can't, and it stays out of feeds until a human
        // promotes it. Sharing wider stays a deliberate act.
        const settings = short_id ? null : await ctx.meta.getOrgSettings(targetOrg)
        const resolvedWorkspaceAccess = short_id
          ? undefined
          : (workspace_access ?? settings?.defaultWorkspaceAccess)
        const resolvedLinkRole = short_id ? undefined : (link_role ?? settings?.defaultLinkRole)
        const resolvedListed = short_id ? undefined : (listed ?? settings?.defaultListed)
        // The only cross-field invariants: a doc can't be listed where it grants no access.
        if (!short_id && resolvedListed === "workspace" && resolvedWorkspaceAccess !== "member")
          return text("A workspace-listed artifact must grant workspace access.")
        if (!short_id && resolvedListed === "public" && resolvedLinkRole === "none")
          return text("A publicly-listed artifact must grant at least a viewer link.")
        // No filename on a single-file publish must never blindly default to
        // index.html: the sniffer types by filename first, so that default silently
        // re-types an existing markdown doc as HTML — the browser then parses the
        // raw markdown as markup and swallows tag-like text. A republish preserves
        // the artifact's current type; a new artifact is sniffed, so markdown
        // content without a filename hint lands as markdown.
        const singleFileFallback = existing
          ? preservingFilename(existing.current_content_type)
          : looksLikeHtmlDocument((content as string | undefined) ?? "")
            ? "index.html"
            : "index.md"
        const { artifact, version } = await publishVersion(
          ctx.meta,
          ctx.blobs,
          {
            bytes,
            filename: isBundle
              ? `${title?.trim() || "bundle"}.zip`
              : (filename ?? singleFileFallback),
            isBundle,
            spa: bundleSpa,
            title: title?.trim(),
            message,
            author: agent.name,
            // Attributed to the human the agent acts for — their profile, their
            // followers' feed (same as the HTTP publish route). The agent itself is the
            // recorded ACTOR, so the activity record reads as its work.
            authorId: actingFor?.id ?? null,
            agentId: agent.id,
            agentName: agent.name,
            source: "mcp",
            // New artifacts land in the TARGETED workspace (the default unless a
            // `workspace` was named), never wider than asked (the workspace's
            // default access when unspecified).
            orgId: targetOrg,
            workspaceAccess: resolvedWorkspaceAccess,
            linkRole: resolvedLinkRole,
            listed: resolvedListed,
            derivedFrom: derivedFromId,
          },
          short_id,
        )
        // Ownership, same as the HTTP route: one row, the human the agent acts
        // for (the agent borrows that standing — no agent rows in the roster).
        if (!short_id)
          await ctx.meta.setArtifactMember({
            id: newId("am"),
            artifact_id: artifact.id,
            user_id: actingFor?.id ?? agent.id,
            role: "owner",
          })
        // Webhook + follower fan-out + thread resolves + realtime/render/re-anchor, via the
        // one shared helper — event parity with the HTTP publish route (an open tab
        // live-reloads, the webhook outbox reaches integrations) with no chance to drift.
        // A publish that fixes feedback resolves those threads directly here.
        const { resolved } = await afterPublish(
          {
            meta: ctx.meta,
            blobs: ctx.blobs,
            bus: ctx.bus,
            notify: ctx.notify,
            notifyRender: ctx.notifyRender,
            background: ctx.background,
            // Thread the dense arm too — agents publish primarily through this tool, so omitting
            // `search` here would leave the bulk of new content lexically-indexed but never embedded.
            search: ctx.search,
            baseUrl: ctx.deps.baseUrl,
            // And the summarizer, for the same reason: this is where most content is written, so
            // an omission here would mean the cards that most need a description never get one.
            summarize: ctx.summarize,
          },
          artifact,
          version,
          {
            isNew: !short_id,
            onBehalf: actingFor?.id ?? null,
            resolves: addresses ?? [],
            actorId: agent.id,
            actorName: agent.name,
          },
        )
        // Tag at publish time — the one-step "auto-tag on create". `tags` given ⇒ set them
        // (normalized, deduped, capped); an empty array clears; omitted leaves them be, so
        // a republish that doesn't mention tags keeps the artifact's existing set.
        if (tags !== undefined) await ctx.meta.setArtifactTags(artifact.id, normalizeTags(tags))
        // The /derive loop: ask the human to review this live version. A brand-profile
        // publish always asks — that round is what makes the profile's reveal a human
        // moment rather than a silent rewrite of every agent's instructions. The whole
        // reviewer fan-out (round, bus, card, email, Slack DM) is the shared helper the
        // HTTP route runs, so the two surfaces cannot drift on it.
        let review_round: string | null = null
        const reviewFor = actingFor?.id ?? (profileAskReview ? profileReviewer : null)
        if ((request_review || profileAskReview) && reviewFor) {
          review_round = await openReviewRound(
            {
              meta: ctx.meta,
              blobs: ctx.blobs,
              bus: ctx.bus,
              baseUrl: ctx.deps.baseUrl,
              notify: ctx.notify,
              pokeWebhooks: ctx.deps.pokeWebhooks,
            },
            artifact,
            {
              reviewer: reviewFor,
              requestedById: agent.id,
              requestedByName: agent.name,
              version: version.n,
              actorId: agent.id,
            },
          )
        }
        const url = artifactUrl(ctx.deps.baseUrl, artifact)
        // Slack completion + bell + auto-open for the human behind the grant — the shared
        // fan-out the HTTP route runs. The delivery receipt becomes `opened_in_tab`, so the
        // agent knows whether to open the URL locally. An attended revision still gets the
        // completion DM, but does not commandeer the person's browser; their live tab reloads.
        let openedInTab = false
        if (actingFor) {
          openedInTab = await agentPushFanout(
            {
              meta: ctx.meta,
              blobs: ctx.blobs,
              bus: ctx.bus,
              baseUrl: ctx.deps.baseUrl,
              pokeWebhooks: ctx.deps.pokeWebhooks,
            },
            artifact,
            {
              user: actingFor.id,
              agentId: agent.id,
              agentName: agent.name,
              version: version.n,
              reviewRound: !!review_round,
              isNew: !short_id,
              notifyBrowser: !attended || !short_id,
            },
          )
        }
        // Each bundle page (including any bound images) is directly fetchable once
        // live — surfacing the URLs here is the fix for an agent that can't find
        // them otherwise and falls back to inlining base64 (see the "cheap image
        // embedding" handoff): no separate call needed to learn where a page serves.
        const pageUrls = isBundle
          ? Object.fromEntries(
              Object.keys(files as Record<string, string>).map((p) => [
                cleanPath(p),
                `${ctx.deps.baseUrl}/raw/${artifact.short_id}/v/${version.n}/${cleanPath(p)}`,
              ]),
            )
          : null
        // The one advisory that needs I/O — computed once here, folded into the
        // note below alongside the pure publishAdvisories.
        const blobAdvisory =
          typeof content === "string" && artifact.kind === "file"
            ? await missingBlobAdvisory(content, ctx.blobs)
            : null
        // What this page's images cost every viewer, every load. Same I/O shape; named
        // rather than silently re-encoded, because these are the user's bytes.
        const weightAdvisory =
          typeof content === "string" && artifact.kind === "file"
            ? await heavyAssetsAdvisory(content, ctx.meta)
            : null
        // Shape drift against the previous version — the quiet way a trend read splits
        // into two metrics that look like one.
        const driftAdvisories =
          typeof content === "string" && artifact.kind === "file"
            ? await slotShapeDriftAdvisories(
                content,
                version.content_type,
                artifact.id,
                version.n - 1,
                ctx.meta,
              )
            : []
        // What the extraction actually STORED for this version, read back from the rows
        // rather than echoed from the parser. Reporting the store is strictly more honest:
        // it reflects what is now queryable, so a persistence failure shows up as an empty
        // list instead of a confident claim. Until now success was silent — a fact was
        // only ever mentioned when something went wrong, which is a poor way to teach a
        // capability whose whole point is that it accrues.
        // assertedOnly: every version now also carries host-derived $rows, and the receipt
        // is the AUTHOR's reward — a receipt that congratulated the host for its own
        // indexes would bury the one line that pays the author for asserting.
        const storedSlots = assertedOnly(
          await ctx.meta.getVersionData(artifact.id, version.n).catch(() => []),
        )
        const payload = {
          published: true,
          short_id: artifact.short_id,
          ...(review_round ? { review_requested: true } : {}),
          kind: artifact.kind,
          ...(version.content_type === LINKED_BUNDLE_CONTENT_TYPE
            ? {
                linked_bundle: true,
                bundle_next: `The logical grouping is live. Read it normally for orientation, or read(short_id:"${artifact.short_id}", data:"${LINKED_BUNDLE_FACT}") for the full manifest.`,
              }
            : {}),
          version: version.n,
          url,
          ...(storedSlots.length
            ? {
                data: storedSlots.map((s) => ({ fact: s.slot, bytes: s.size_bytes })),
                data_next: `Queryable now: read(short_id:"${artifact.short_id}", data:"${storedSlots[0]?.slot}") for this version, or versions:"all" for the whole series.`,
              }
            : {}),
          // Single-file publishes report the stored bytes' sha256 (the content-
          // addressed blob key) so callers can verify what landed matches what
          // they sent.
          ...(artifact.kind === "file" ? { content_sha256: version.blob_key } : {}),
          ...(pageUrls ? { page_urls: pageUrls } : {}),
          // The publish→look loop: a screenshot of the served page is queued at every
          // publish; seeing it is the only way to catch purely-visual breakage. Where the
          // instance renders nothing, this pointer would send the caller to a `read` that
          // can only fail — so it says that here instead, at the moment the expectation is
          // set, rather than one wasted round trip later.
          render: ctx.deps.renderPreviews
            ? `queued — call read(short_id:"${artifact.short_id}", render:"top") in a few seconds to SEE the published page ("full"/"marked" for the whole page, or with the region map's @N refs drawn on it).`
            : rendersOff("A screenshot of this page", url),
          title: artifact.title,
          workspace_access: artifact.workspace_access,
          link_role: artifact.link_role,
          listed: artifact.listed,
          ...(artifact.derived_from ? { derived_from } : {}),
          ...(editsApplied ? { edits_applied: editsApplied } : {}),
          ...(slideOpsApplied ? { slide_ops_applied: slideOpsApplied } : {}),
          ...(resolved.length ? { resolved } : {}),
          ...(actingFor ? { opened_in_tab: openedInTab } : {}),
          note:
            (merge
              ? `Live now — merged ${Object.keys(files as Record<string, string>).length} file(s) into the bundle (new current version).`
              : short_id
                ? "Live now — published a new current version."
                : "Live now — created a new artifact in your workspace.") +
            (actingFor && !openedInTab
              ? " No open Derive tab caught this push — open the url for the user (e.g. run `open <url>`) if they should see it now."
              : "") +
            // Advisories over what was just stored (missing viewport meta, oversized
            // inline base64, expiring upload URLs, page-markup-as-markdown, broken
            // blob refs). `content` holds the full document for both direct and
            // edits publishes — materializeEdits assigned into it above.
            (typeof content === "string" && artifact.kind === "file"
              ? [
                  ...publishAdvisories(content, version.content_type),
                  ...(blobAdvisory ? [blobAdvisory] : []),
                  ...(weightAdvisory ? [weightAdvisory] : []),
                  ...driftAdvisories,
                ]
                  .map((advisory) => ` ${advisory}`)
                  .join("")
              : // A bundle gets no publishAdvisories (they read one document), but a facts
                // block inside one of its pages is dropped SILENTLY — say so.
                ((files ? bundleFactsAdvisory(files as Record<string, string>) : null)?.replace(
                  /^/,
                  " ",
                ) ?? "")),
        }
        // PUBLISH → SEE IT, in one call. Without `render` this is exactly the old
        // response. With it, wait for the shot and hand it back here, because the
        // publish-then-go-look-at-it loop is two calls and a guess at how long to
        // sleep — and an agent cannot simply open the tab instead.
        // Asked for a picture this instance cannot take: `collectRender` would poll out the
        // caller's whole `wait` before returning null, and the ordinary not-ready ending
        // would then advise a `read` that fails the same way. Answer immediately instead.
        if (render && !ctx.deps.renderPreviews) {
          payload.render = rendersOff(`The render:${render} of this page`, url)
        } else if (render) {
          const shot = await collectRender(
            ctx,
            artifact.id,
            version.n,
            render as RenderVariant,
            wait ?? 0,
          )
          // The SAME ceiling `read` applies. Half density bounds the common case, it does
          // not guarantee one: a long enough page still clears the cap, and base64-ing
          // multiple MB into a single MCP message is the client-side blowup `read`
          // deliberately refuses to cause. Over the cap, fall through to the ordinary
          // response, which already says how to collect it.
          if (shot && shot.bytes.length <= IMAGE_INLINE_MAX)
            return {
              content: [
                {
                  type: "text" as const,
                  // The generic `render` field is a POINTER to go look — wrong the moment
                  // the picture is already attached to this same response. Unset, it told
                  // an agent to call read again for something already in hand.
                  text: JSON.stringify({ ...payload, render: "attached below" }, null, 2),
                },
                { type: "image" as const, data: toBase64(shot.bytes), mimeType: shot.mimeType },
              ],
            }
          // Not ready inside the wait. Say WHY rather than falling through to the generic
          // "queued — call read(...)" pointer, which ignores that a render was asked for
          // and reads as though nothing was requested.
          payload.render =
            wait && wait > 0
              ? `not ready within ${wait}s — call read(short_id:"${artifact.short_id}", render:"${render}", wait:30) to collect it.`
              : `requested but not waited for — pass \`wait\` (seconds) to get it inline, or call read(short_id:"${artifact.short_id}", render:"${render}", wait:30).`
        }
        return json(payload)
      } catch (e) {
        const msg = e instanceof PublishError ? e.message : "could not publish"
        return text(`Publish failed: ${msg}`)
      }
    },
  )
}
