import {
  artifactUrl,
  assertedOnly,
  EditError,
  heavyAssetsAdvisory,
  looksLikeHtmlDocument,
  missingBlobAdvisory,
  newId,
  PublishError,
  propose as proposeChange,
  publishAdvisories,
  publish as publishVersion,
  type Role,
  roleAllows,
  slotShapeDriftAdvisories,
} from "@derive/core"
import { z } from "zod"
import { PROFILE_PLACEHOLDER_HTML } from "../brandprint-reference"
import { markAddressed } from "../lib/addressed"
import { afterPublish } from "../lib/after-publish"
import { cleanPath, mergeBundleZip, zipBundleFiles } from "../lib/bundle"
import {
  collectRender,
  RENDER_VARIANTS,
  RENDER_WAIT_MAX,
  type RenderVariant,
} from "../lib/collect-render"
import { type MaterializedEdits, materializeEdits, preservingFilename } from "../lib/edits"
import { buildReviewEmail } from "../lib/email"
import { MAX_UPLOAD_BYTES } from "../lib/http"
import { badChoice, choiceDescription } from "../lib/open-choice"
import { enqueueSlackReviewRequestedDm } from "../lib/slack-dm"
import { normalizeTags } from "../lib/tags"
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
  withTimeout,
} from "../mcp-util"
import { enqueueChannelDelivery } from "../webhooks"

export function registerPublishTool(tc: ToolContext): void {
  const {
    server,
    ctx,
    agent,
    actingFor,
    ownerId,
    defaultOrg,
    defaultRole,
    reach,
    resolveWs,
    wsArg,
  } = tc

  // Resolve derive://brandprint/profile to the workspace's brand-profile artifact,
  // scaffolding it (conventions collection + "Brand profile" placeholder + settings
  // pointer) on first use. This is the former setup_brandprint, folded in so the brand
  // profile is a publish TARGET rather than a separate tool. INVARIANT (critical safety):
  // the scaffold's WRITES fire ONLY when the caller holds `manage` (Owner/Admin); a
  // non-manage caller for whom nothing is set up yet gets an actionable error naming an
  // Admin, and NO write happens. Reusing an already-set-up profile needs no manage (a
  // normal for_review revision). Body copied verbatim from setup_brandprint.
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
          "This workspace has no Brandprint profile yet, and only an Admin/Owner can set one up. Ask an Admin to publish to derive://brandprint/profile once (that scaffolds it); after that anyone with publish rights can propose revisions.",
      }
    // The scaffold below is a real live write (a collection create + a placeholder
    // publish) — unlike the profile's own reveal/revision, which always routes to a
    // human-approved proposal (see `profileForReview` in the caller) and so stays free
    // of this gate. A billing-blocked workspace must refuse the scaffold exactly like
    // any other live publish, and BEFORE any of it writes.
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

  // WRITE — publish live, or file a proposal for review -----------------------
  server.registerTool(
    "publish",
    {
      description:
        "Publish a document: pass `short_id` to UPDATE an existing one, omit it to CREATE a new one (`title` required). Choose ONE payload by what you're changing. DEFAULT to `edits` for any change to an existing doc — it is the safe, precise option: exact find/replace against the stored source, so read format:'html' FIRST or it won't match, and it fails unless each search string hits exactly once (add surrounding text to make it unique). Use `content` to write or fully replace a single file, or `files` for a multi-page bundle. Do NOT inline anything past ~a page or any image/font — use stage (target:'doc' for a whole big doc/bundle, target:'asset' for an image/font) instead; oversized inline payloads are rejected. Publishes go LIVE at your role; pass for_review:true to file a PROPOSAL a human approves instead (nothing changes until they do). Pass `addresses` (thread ids from catch_up) to resolve the feedback this revision answers. As a short_id you may pass derive://brandprint/profile to file this workspace's brand profile (an Admin's first publish there scaffolds the fact). Pass `render` (with `wait`) to get the screenshot back here instead of a second call. Read derive://skills/publishing before bundles or edits, and derive://skills/assets before embedding images or fonts.",
      inputSchema: {
        content: z
          .string()
          .optional()
          .describe(
            "The complete content for a SINGLE-FILE artifact (HTML or Markdown). Use this OR `files`, not both. Stage images and fonts, then embed the upload response's permanent url (never upload_url or a base64 data: URI here) — see derive://skills/assets. Push a large document via stage target:'doc' rather than inlining it — see derive://skills/publishing.",
          ),
        files: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            "A MULTI-PAGE bundle as a map of path → content — the whole site. Each value is a text page (plain string), a base64 data: URI for a small inline binary, or — PREFERRED for real images/fonts — the exact \"asset:<hash>\" ref returned after uploading through stage target:'asset'. The root index.html (else the shallowest .html) becomes the entry page; a plain republish REPLACES the bundle, so include every page and asset (or use `merge`). See derive://skills/assets for staged refs and derive://skills/publishing for bundle semantics.",
          ),
        title: z
          .string()
          .optional()
          .describe(
            "Title for a NEW artifact (required when creating). On republish, renames only if provided.",
          ),
        short_id: z
          .string()
          .optional()
          .describe("Omit to create a new artifact; pass it to revise one you own."),
        workspace_access: z
          .enum(["none", "member"])
          .optional()
          .describe(
            "Do THIS workspace's members reach a NEW artifact (each at their seat role — admin/editor/commenter)? member (the usual default — a pasted link opens for a teammate) or none (invite-only, even for the workspace). Omit to use the workspace's default. Ignored on republish.",
          ),
        link_role: z
          .enum(["none", "viewer", "commenter", "editor"])
          .optional()
          .describe(
            "What merely holding a NEW artifact's URL confers on ANYONE (incl. people outside the workspace): none (no world link — the usual default), viewer, commenter, or editor. Anonymous holders are always clamped to viewer. Omit to use the workspace's default. Ignored on republish.",
          ),
        listed: z
          .enum(["none", "workspace", "public"])
          .optional()
          .describe(
            "Where a NEW artifact SURFACES for discovery (no access of its own): none (no feeds/libraries — the usual default; a human promotes it when ready), workspace (the team library — needs workspace_access=member), or public (the public directory — needs a link_role). Omit to use the workspace's default. Ignored on republish — the human promotes via the share dialog.",
          ),
        spa: z
          .boolean()
          .optional()
          .describe(
            "For a NEW bundle only: serve unknown paths from the entry page (single-page-app routing). Default false.",
          ),
        merge: z
          .boolean()
          .optional()
          .describe(
            "Add/overwrite the given `files` INTO the existing bundle instead of replacing it (default false). Requires `short_id` of a bundle; same-path files overwrite, the rest are kept. See derive://skills/publishing.",
          ),
        message: z.string().optional().describe("What changed — recorded as the version message."),
        tags: z
          .array(z.string())
          .optional()
          .describe(
            "Browse tags to set on the artifact — workspace-wide labels that make it findable (organize shows the vocabulary and proposes tags from similar docs). Reuse an existing tag over a near-duplicate. Given ⇒ REPLACES the set (normalized: trimmed, lowercased, deduped, capped 20); [] clears; omitted leaves existing tags untouched on a republish.",
          ),
        filename: z
          .string()
          .optional()
          .describe(
            "Filename hint for the content type of a single file, e.g. index.html or notes.md.",
          ),
        for_review: z
          .boolean()
          .optional()
          .describe(
            "File this as a PROPOSAL for a human to approve instead of publishing live (single-file only). Forced on when your role can't publish directly.",
          ),
        addresses: z
          .array(z.string())
          .optional()
          .describe(
            "Thread ids (from catch_up) this revision resolves. On a live publish they resolve; on a proposal they flip to `addressed` and resolve on approval.",
          ),
        request_review: z
          .boolean()
          .optional()
          .describe(
            "After a LIVE publish, open a review round asking your human to review this version — the /derive loop. They answer inline and hit Send back (or Approve); poll catch_up's `review` for the state. No effect on a proposal (that already IS a review).",
          ),
        // SEE IT in the same call. Optional and off by default, so an existing caller's
        // response shape never changes.
        render: z
          .string()
          .optional()
          .describe(
            choiceDescription(
              RENDER_VARIANTS,
              "Return a screenshot of the published page with this response, instead of a second read.",
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
                    "Exact text from the STORED SOURCE (read format:'html' first on an HTML artifact — the markdown view will not match). Must occur exactly once, unless `occurrence` picks one of several.",
                  ),
                new_str: z.string().describe("Replacement text. Empty string deletes."),
                occurrence: z.coerce
                  .number()
                  .optional()
                  .describe(
                    "1-based index of WHICH match to replace, when old_str is intentionally non-unique (a phrase repeated verbatim). Omit when old_str already matches once.",
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
                    "Locates the edit by RENDERED text (the selector comment anchors use) instead of raw source — no format:'html' read needed. Strict resolution: the context must pin exactly one spot (or the exact be globally unique), the span may not cross markup, and a miss applies nothing.",
                  ),
                new_text: z
                  .string()
                  .describe("Replacement for the quoted span, as plain text. Empty deletes."),
              }),
            ]),
          )
          .optional()
          .describe(
            "Surgical revision of a SINGLE-FILE artifact without resending it. Two shapes, not mixable in one batch: {old_str, new_str} — exact-match against the current stored source, applied in order (read format:'html' first so old_str matches the raw source); or {quote: {exact, prefix, suffix}, new_text} — located by VISIBLE text and resolved server-side, no raw read needed. Requires `short_id`; use INSTEAD of `content`. See derive://skills/publishing. A miss applies nothing and returns why.",
          ),
        base_version: z.coerce
          .number()
          .optional()
          .describe(
            "Safety check for `edits`: pass the version you read; the publish errors instead of applying when the artifact has moved past it.",
          ),
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
      tags,
      filename,
      for_review,
      addresses,
      request_review,
      render,
      wait,
      workspace,
      edits,
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
      // The brand profile is never published LIVE — its reveal/revision is always a
      // human-approved proposal. Also its exemption from the total-inline cap below (it has
      // no out-of-band path to its URI). Computed from the RAW target, before resolution.
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
      // as a short_id. The profile's reveal is always a proposal (profileForReview).
      let profileForReview = false
      if (short_id?.startsWith("derive://")) {
        if (isProfileTarget) {
          const t = await resolveWs(workspace)
          if ("error" in t) return text(t.error)
          const uid = actingFor?.id ?? ownerId
          if (!uid)
            return err(
              "Publishing the brand profile needs a signed-in user to attribute it to. Connect with an OAuth agent grant rather than a static agent token.",
            )
          const resolved = await resolveBrandprintProfileTarget(t.org, t.role, uid)
          if ("error" in resolved) return err(resolved.error)
          short_id = resolved.profileShortId
          profileForReview = true
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
        } else {
          return err(
            `Can't publish to "${short_id}" — the only writeable derive:// target is derive://brandprint/profile.`,
          )
        }
      }
      // Revise an existing artifact wherever it lives (reach roams to its
      // workspace, within the grant); create a new one in the targeted (or
      // default) workspace. The acting role is re-capped to that workspace, so
      // publish/propose gating is correct there, not just in the default one.
      const reached = short_id ? await reach(short_id, workspace) : null
      if (reached && "error" in reached) return text(reached.error)
      const existing = reached && !("error" in reached) ? reached.a : null
      if (short_id && !existing) return text(`No artifact "${short_id}" you can reach.`)
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

      // `edits` — materialize the full new content up front, then fall through to the
      // untouched publish/proposal pipeline (sweep, addresses, receipts all inherit).
      let editsApplied = 0
      if (edits !== undefined) {
        if (content !== undefined || files)
          return err("Provide `edits` OR `content`/`files`, not both.")
        if (!existing) return err("`edits` revises an EXISTING artifact — pass its `short_id`.")
        let materialized: MaterializedEdits
        try {
          materialized = await materializeEdits(
            { getVersion: ctx.meta.getVersion.bind(ctx.meta), sourceText: ctx.sourceText },
            existing,
            edits,
            base_version,
          )
        } catch (e) {
          if (e instanceof EditError) return err(e.message)
          throw e
        }
        // Same size/storage ceiling the REST /versions and /proposals routes apply
        // after materializing edits — without this the MCP tool could write an
        // over-quota version the HTTP surfaces would have rejected.
        const editedBytes = new TextEncoder().encode(materialized.content).length
        if (editedBytes > MAX_UPLOAD_BYTES) return err("Edited content is too large.")
        if (await ctx.overStorage(targetOrg, editedBytes))
          return err(`"${short_id}"'s workspace storage quota is exceeded.`)
        content = materialized.content
        editsApplied = edits.length
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
      }

      // Direct publish is gated on the agent's role (Creator/Admin). A commenter-level
      // grant — or anyone asking for_review, or a publish to the brand profile (whose
      // reveal is always human-approved) — is routed to a human-reviewed proposal, so a
      // low-privilege agent still can't push live content.
      const review = for_review === true || profileForReview || !roleAllows(actRole, "publish")
      if (review) {
        if (!roleAllows(actRole, "propose"))
          return text(
            "Your grant is read-only (derive:read). Re-authorize with derive:propose (or a publish scope) to suggest changes.",
          )
        if (isBundle)
          return text(
            "Multi-page bundles can't be proposed for review yet — only published directly. Ask an editor to publish, or submit a single-file `content` revision.",
          )
        if (!existing)
          return text(
            "A proposal revises an EXISTING artifact — pass its `short_id`. Creating a new artifact needs publish rights (a Creator/Admin grant).",
          )
        try {
          const { proposal } = await proposeChange(ctx.meta, ctx.blobs, short_id as string, {
            bytes: new TextEncoder().encode(content as string),
            // The sniffer types by filename first: a bare index.html default would
            // re-type a markdown artifact as HTML when the proposal is approved.
            filename: filename ?? preservingFilename(existing.current_content_type),
            isBundle: false,
            message: message ?? "Proposed revision",
            author: agent.name,
            author_id: agent.id,
            // Delegation provenance: the agent proposes on behalf of the human that
            // authorized it, so reviewers see "Agent X on behalf of Alice."
            on_behalf_of: actingFor?.id ?? null,
          })
          const addressed = addresses?.length
            ? await markAddressed(ctx.meta, existing.id, proposal.id, addresses)
            : []
          for (const threadId of addressed)
            ctx.bus.publish(existing.id, {
              type: "comment.addressed",
              thread_id: threadId,
              state: "addressed",
            })
          return json({
            published: false,
            proposed: true,
            proposal_id: proposal.id,
            base_version: proposal.base_version,
            addressed,
            ...(editsApplied ? { edits_applied: editsApplied } : {}),
            note: "Submitted for review — a human approves it or requests changes. It is NOT live yet.",
          })
        } catch (e) {
          return text(
            `Couldn't store the proposal: ${e instanceof PublishError ? e.message : "unknown error"}.`,
          )
        }
      }

      // Live publish path. Gated on billing here, not up with the `edits` storage check
      // above — that check also runs for the propose branch (which stays free), so the
      // billing gate has to sit strictly after the review/propose split.
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
            // followers' feed (same as the HTTP publish route).
            authorId: actingFor?.id ?? null,
            source: "mcp",
            // New artifacts land in the TARGETED workspace (the default unless a
            // `workspace` was named), never wider than asked (the workspace's
            // default access when unspecified).
            orgId: targetOrg,
            workspaceAccess: resolvedWorkspaceAccess,
            linkRole: resolvedLinkRole,
            listed: resolvedListed,
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
        // A live publish that fixes feedback resolves those threads directly here (no
        // approval step, unlike a proposal's `addressed`).
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
          },
          artifact,
          version,
          { isNew: !short_id, onBehalf: actingFor?.id ?? null, resolves: addresses ?? [] },
        )
        // Tag at publish time — the one-step "auto-tag on create". `tags` given ⇒ set them
        // (normalized, deduped, capped); an empty array clears; omitted leaves them be, so
        // a republish that doesn't mention tags keeps the artifact's existing set.
        if (tags !== undefined) await ctx.meta.setArtifactTags(artifact.id, normalizeTags(tags))
        // The /derive loop: ask the human to review this live version.
        let review_round: string | null = null
        if (request_review && actingFor) {
          const round = await ctx.meta.createReviewRound({
            id: newId("rr"),
            artifact_id: artifact.id,
            version: version.n,
            requested_by: agent.id,
            requested_for: actingFor.id,
          })
          review_round = round.id
          ctx.bus.publish(artifact.id, { type: "review.requested", round_id: round.id })
          await ctx.notify(artifact, "review.requested", {
            version: version.n,
            requested_by: agent.name,
          })
          // The review request is the one event that earns an email: the loop is
          // blocked on the human, who may have no tab open (same policy as the
          // HTTP publish path). `settings` is only pre-loaded on a create, so a
          // republish (where most review rounds happen) fetches the gate here.
          if ((settings ?? (await ctx.meta.getOrgSettings(targetOrg))).emailNotifications) {
            const [r] = await ctx.meta.getUsers([actingFor.id])
            if (r?.email)
              await enqueueChannelDelivery(ctx.meta, "email", "review.requested", {
                to: r.email,
                toName: r.name ?? undefined,
                ...buildReviewEmail(ctx.deps.baseUrl, artifact, {
                  requestedBy: agent.name,
                  version: version.n,
                }),
              })
          }
          // Same interrupt, mirrored to Slack (independent of the email gate above —
          // gated on the reviewer's own Slack-DM preference instead).
          await enqueueSlackReviewRequestedDm(
            { meta: ctx.meta, baseUrl: ctx.deps.baseUrl },
            artifact,
            { requestedBy: agent.name, version: version.n },
            actingFor.id,
          )
        }
        const url = artifactUrl(ctx.deps.baseUrl, artifact)
        // Bell entry for the human behind the grant, so a push reaches them even
        // with no tab open (the on-the-go path). One row per push that warrants
        // one: a review ask beats a plain "published" (never both).
        if (actingFor && (review_round || !short_id)) {
          const row = {
            id: newId("n"),
            user_id: actingFor.id,
            actor: agent.name,
            kind: review_round ? ("review" as const) : ("publish" as const),
            artifact_id: artifact.id,
            artifact_short_id: artifact.short_id,
            artifact_title: artifact.title,
            thread_id: "",
            comment_id: "",
            preview: review_round
              ? `requested your review of v${version.n}`
              : (artifact.title ?? "published something new"),
          }
          await ctx.meta.createNotification(row)
          ctx.bus.publish(`u:${actingFor.id}`, {
            type: "notification",
            notification: { ...row, read: 0, created_at: new Date().toISOString() },
          })
        }
        // Auto-open: tell the granting user's open tabs an agent just pushed. The
        // delivery receipt (how many live streams caught it) becomes
        // `opened_in_tab`, so the agent knows whether to open the URL locally.
        let openedInTab = false
        if (actingFor) {
          const channel = `u:${actingFor.id}`
          // Same service flag as the /v1 publish path: a context-bound agent's
          // push is routinely someone ELSE's ask — the client toasts instead of
          // auto-opening the owner's tab.
          const contexts = await ctx.meta.listContexts(artifact.org_id)
          const service = contexts.some((x) => x.agent_id === agent.id)
          const pushed = {
            type: "artifact.pushed" as const,
            event_id: newId("ev"),
            short_id: artifact.short_id,
            artifact_id: artifact.id,
            title: artifact.title,
            version: version.n,
            kind: short_id ? "revised" : "created",
            url,
            agent: agent.name,
            review_requested: !!review_round,
            service,
          }
          if (ctx.bus.publishWithReceipt) {
            openedInTab =
              (await withTimeout(ctx.bus.publishWithReceipt(channel, pushed), 1500, 0)) > 0
          } else {
            ctx.bus.publish(channel, pushed)
          }
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
          // publish; seeing it is the only way to catch purely-visual breakage.
          render: `queued — call read(short_id:"${artifact.short_id}", render:"top") in a few seconds to SEE the published page ("full"/"marked" for the whole page, or with the region map's @N refs drawn on it).`,
          title: artifact.title,
          workspace_access: artifact.workspace_access,
          link_role: artifact.link_role,
          listed: artifact.listed,
          ...(editsApplied ? { edits_applied: editsApplied } : {}),
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
              : ""),
        }
        // PUBLISH → SEE IT, in one call. Without `render` this is exactly the old
        // response. With it, wait for the shot and hand it back here, because the
        // publish-then-go-look-at-it loop is two calls and a guess at how long to
        // sleep — and an agent cannot simply open the tab instead.
        if (render) {
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
