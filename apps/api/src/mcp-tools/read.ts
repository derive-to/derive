import {
  artifactUrl,
  DECK_TEMPLATE,
  type DocMap,
  derivedGen,
  deriveFacts,
  docMap,
  isDerivedFactName,
  isHtmlLike,
  LINKED_BUNDLE_CONTENT_TYPE,
  LINKED_BUNDLE_FACT,
  landmarkSlice,
  landmarksOf,
  mapJson,
  newId,
  type OutlineSection,
  outlineOf,
  parseTemplateLibraryUri,
  refsOf,
  resolveNode,
  SKILL_CONTENT_TYPE,
  sectionOf,
  TEMPLATE_LIBRARY_CATALOG_URI,
  templateLibraryUri,
  toMarkdown,
  type VersionDataRecord,
  type VersionRecord,
  VIDEO_TEMPLATE,
  validateLinkedBundle,
} from "@derive/core"
import { z } from "zod"
import { BRANDPRINT_REFERENCE, BRANDPRINT_TEMPLATE } from "../brandprint-reference"
import { cleanPath } from "../lib/bundle"
import { boundSources, sourceTools } from "../lib/chat-sources"
import { clip, MAX_CHARS } from "../lib/clip"
import { pickVariant, rendersOff } from "../lib/collect-render"
import { assembleContextPackage } from "../lib/context-package"
import { sniffImageType } from "../lib/image"
import { baseType, isTextType, present, type ReadFormat, searchMatcher } from "../lib/search"
import { WeightedLruCache } from "../lib/source-text-cache"
import { canReadTemplateLibrary } from "../lib/template-library-access"
import { templateLibraryEntryJson } from "../lib/template-library-entry"
import { log } from "../log"
import type { ToolContext } from "../mcp-tool-context"
import {
  clipDoc,
  DATA_SERIES_MAX,
  doc,
  err,
  FULL_DOC_MAX,
  formatLabel,
  historyNotPublic,
  IMAGE_INLINE_MAX,
  json,
  manifestOf,
  PAGE_MAP_MAX,
  parseLineRange,
  parseVersionRange,
  runnerOnline,
  safeJson,
  skillFilesFooter,
  skillReading,
  skillsCatalog,
  sleep,
  toBase64,
  versionOpenToWorld,
} from "../mcp-util"
import { CORE_SKILLS } from "../skills-reference.gen"

/** Does this version's KIND carry facts at all? Extraction and derivation both run on
 *  single-file HTML/markdown only (after-publish.ts), so a bundle, deck or binary carries
 *  neither asserted nor derived rows — and telling its author to embed a block is telling
 *  them to do the thing that was just silently ignored. Found by dogfooding: a bundle
 *  whose index.html DID carry a valid block still read back as "embed a block to add one". */
const kindCarriesFacts = (v: VersionRecord | null): boolean =>
  v?.content_type === "text/html" ||
  v?.content_type === "text/markdown" ||
  // A deck carries DERIVED rows ($map above all) though it can embed none of its own.
  isHtmlLike(v?.content_type ?? "")

interface StoredMap {
  kind: string
  bytes: number
  nodes: Record<string, unknown>[]
  truncated?: boolean
  total?: number
}

/** A stored `$map` row is host-derived, but legacy or corrupt cache data must still fall
 *  back to the source parser instead of changing a read into a 500. */
const storedMapOf = (source: string): StoredMap | null => {
  const value = safeJson(source)
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (typeof row.kind !== "string" || typeof row.bytes !== "number" || !Array.isArray(row.nodes))
    return null
  if (
    row.nodes.some(
      (node) =>
        !node ||
        typeof node !== "object" ||
        Array.isArray(node) ||
        typeof (node as Record<string, unknown>).ref !== "string" ||
        typeof (node as Record<string, unknown>).type !== "string",
    )
  )
    return null
  if (row.truncated !== undefined && row.truncated !== true) return null
  if (row.total !== undefined && typeof row.total !== "number") return null
  return {
    kind: row.kind,
    bytes: row.bytes,
    nodes: row.nodes as Record<string, unknown>[],
    ...(row.truncated === true ? { truncated: true } : {}),
    ...(typeof row.total === "number" ? { total: row.total } : {}),
  }
}

/** A focus read returns enough complete parts to disambiguate a repeated term, while the
 *  response stays well below the ordinary whole-read budget. The ref lets the caller open
 *  the exact source next without another map call. */
const FOCUS_MATCH_MAX = 3
const FOCUS_BODY_MAX = Math.floor(MAX_CHARS / FOCUS_MATCH_MAX)
const clipFocusBody = (body: string): string =>
  body.length > FOCUS_BODY_MAX
    ? `${body.slice(0, FOCUS_BODY_MAX)}\n\n…[truncated ${body.length - FOCUS_BODY_MAX} chars — read this node for the full clipped part]`
    : body

/** Why a fact is absent, said accurately — the cases the old single message merged.
 *  A `$name` can never be embedded (the author grammar rejects `$`), so "embed a block"
 *  is impossible advice for it; a bundle can't carry facts at all; everything else is the
 *  ordinary "nobody asserted this yet". `present` is what the version DOES carry, so the
 *  reply both explains the absence and shows the alternatives. */
const absenceNote = (
  name: string | null,
  v: VersionRecord | null,
  ref: string,
  present: string[] = [],
): string => {
  const also = present.length ? ` This version carries: ${present.join(", ")}.` : ""
  if (!kindCarriesFacts(v))
    return `${ref} is a ${v?.content_type === "derive/skill" ? "skill" : "bundle or non-text"} version, which carries no facts — asserted or derived. Facts are extracted from single-file HTML and markdown only, so a derive-facts block inside a bundle page is not read.`
  if (name && isDerivedFactName(name))
    return `${ref} has no "${name}". Derived facts are computed by the host, never embedded — "${name}" is absent because this version's content produced none ($outline needs two or more sections, $links needs a reference to another artifact).${also}`
  if (present.length)
    return `No facts "${name}" in ${ref} — facts: ${present.join(", ")}. Pass data:"*" to list them.`
  return `${ref} carries no facts — embed a derive-facts block to add one.`
}

/**
 * Recompute a version's derived facts from its own bytes and persist them, returning the
 * fresh set. The lazy half of derivation: publish-time covers new versions, this covers
 * every version that predates derivation (or a deriver's gen bump) — but ONLY from the
 * single-version named read, so the cost is one blob and one pass, ever, per version.
 *
 * The response is not held for the write: the derivation is pure and fast, so the VALUE
 * returns now while the rows persist through background() (waitUntil on Workers).
 *
 * The write is prefix-scoped (setDerivedVersionData) rather than a read-union-replace.
 * That is a correctness requirement, not a tidiness one: this is the SECOND writer to an
 * old version's rows, and the backfill is the first. A union built from a read taken
 * before the backfill's write would delete the author's fact it just added, and nothing
 * would restore it, because the next publish sees that fact already tracked and never
 * re-walks. Scoping the delete to `$` means no interleaving can express that loss.
 */
const lazyDeriveVersion = async (
  ctx: ToolContext["ctx"],
  artifactId: string,
  v: VersionRecord | null,
  n: number,
): Promise<VersionDataRecord[] | null> => {
  const ct = v?.content_type ?? ""
  if (!v || (ct !== "text/markdown" && !isHtmlLike(ct))) return null
  const source = await ctx.sourceText(v)
  if (source == null) return null
  const derived = deriveFacts(source, ct)
  const freshRows: VersionDataRecord[] = derived.map((s) => ({
    id: newId("vd"),
    artifact_id: artifactId,
    n,
    slot: s.slot,
    json: s.json,
    size_bytes: s.bytes,
    gen: s.gen,
    created_at: v.created_at,
  }))
  ctx.background(
    ctx.meta.setDerivedVersionData(
      artifactId,
      n,
      freshRows.map((r) => ({
        id: r.id,
        slot: r.slot,
        json: r.json,
        size_bytes: r.size_bytes,
        gen: r.gen,
      })),
    ),
  )
  return freshRows
}

export function registerReadTool(tc: ToolContext): void {
  const {
    server,
    ctx,
    bpProfile,
    profileArt,
    reach,
    notFound,
    wsArg,
    num,
    staleNote,
    actingFor,
    agent,
    ownerId,
    inGrant,
    resolveWs,
    askableContexts,
  } = tc
  // A source blob is immutable. Keep its parsed structure beside the hot source-text
  // cache so repeated focus and node reads do not rebuild thousands of node objects.
  // This cache is deliberately smaller: the source text remains the useful primary copy.
  const structures = new WeightedLruCache<DocMap>({
    maxBytes: 8 * 1024 * 1024,
    maxEntries: 64,
    maxEntryBytes: 2 * 1024 * 1024,
  })
  const structureOf = (v: VersionRecord, source: string, contentType: string): DocMap => {
    const key = `${contentType}:${v.blob_key}`
    const cached = structures.get(key)
    if (cached) return cached
    const structure = docMap(source, contentType)
    const bytes = structure.nodes.reduce(
      (total, node) => total + 192 + (node.title?.length ?? 0) * 2,
      256,
    )
    structures.set(key, structure, bytes)
    return structure
  }

  // READ CONTENT --------------------------------------------------------------
  server.registerTool(
    "read",
    {
      description:
        "Read an artifact. Small docs return whole; large docs return an outline. `focus` returns matching parts in one call. `map` then `node` addresses one part. format:'html' gives exact source for publish edits. Also reads contexts and derive:// URIs. See derive://skills/finding.",
      // readOnlyHint stays true despite two incidental write paths below (the lazy
      // derived-fact backfill and the render self-heal re-queue): both are deterministic
      // recomputations/cache-fills of already-published bytes — the class of side effect
      // an HTTP GET tolerates — never a mutation of anything a user authored.
      annotations: {
        title: "Read an artifact",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        short_id: z
          .string()
          .describe(
            "An artifact short id. Also a ctx_ id/name, or a derive:// URI (skills, brandprint, decks/template, sources).",
          ),
        section: z
          .string()
          .optional()
          .describe(
            'A heading slug, or "@2" for a region. Bundle: a page path, optionally page.html#slug. "*" forces the whole (clipped) doc. Omitted: small returns whole, large returns an outline.',
          )
          // Four different addressing schemes share one string param, and the difference is
          // not inferable from the type. The slug form is the one to lead with because it
          // is what an outline hands back.
          .meta({ examples: ["risks", "@2", "docs/pricing.html#tiers", "*"] }),
        format: z
          .enum(["markdown", "html", "text"])
          .optional()
          .describe(
            "markdown (default) | html: the exact stored source, required BEFORE publish `edits` | text: flat visible text, what comment `quote`s anchor against.",
          ),
        lines: z
          .string()
          .optional()
          .describe(
            '1-indexed inclusive line range of the body in the chosen format: "40-120", "40", "40-".',
          ),
        render: z
          .enum(["top", "full", "marked"])
          .optional()
          .describe(
            'SEE the page as a viewer does, catching visual breakage no text read can. "top" is the 1200x630 crop, "full" the whole page, "marked" adds @N region refs.',
          ),
        wait: num("wait", { int: true, min: 1, max: 30 })
          .optional()
          .describe(
            "With `render`: block up to this many seconds (max 30) for a screenshot that is still computing.",
          ),
        map: z
          .boolean()
          .optional()
          .describe(
            "The document's addressable parts: one line per node with the `ref` that names it. Read this first to work on part of a big doc.",
          ),
        node: z.string().optional().describe("One ref from map (slide:2, sec:pricing)."),
        focus: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .describe("Literal text; returns matching parts with refs.")
          .meta({ examples: ["pricing", "fallback", "quarterly target"] }),
        version: num("version").optional(),
        data: z
          .string()
          .optional()
          .describe('A version\'s stored fact slot, by name. "*" lists what this version carries.'),
        versions: z
          .string()
          .optional()
          .describe(
            'With `data`: that slot across a version RANGE in one call — "1-30", "12", "20-", "all". Oldest first.',
          ),
        workspace: wsArg,
      },
    },
    async ({
      short_id,
      section,
      format,
      version,
      lines,
      map: wantMap,
      node,
      focus,
      render,
      wait,
      data,
      versions,
      workspace,
    }) => {
      const fmt: ReadFormat = format ?? "markdown"
      // `derive://brandprint/*` URIs are readable through `read`, not only as MCP
      // resources — the exact strings the server instructions name, reachable by every
      // client even where resource support is weak or was never negotiated (the failure
      // this fixes: a session that connected before the Brandprint existed caches "no
      // resources" for its whole life). `reference`/`template` are the static build guide;
      // `profile` is the live brand profile; any other segment is a source-doc short_id
      // that falls through to the normal read path (so `section`/`lines`/`version` work).
      // `derive://skills/<name>` resolves the same way, so the core-skill strings the
      // instructions index names are readable through `read` even where MCP resources
      // aren't — same response shape as the Brandprint reference below.
      // `derive://sources` and `derive://sources/<id>` — the connections this workspace has
      // DECLARED for chat, and one server's tool catalog. Served here rather than as generated
      // tool definitions because MCP schemas are large and the chat surface has a size budget:
      // an index costs a line per connection, a catalog is fetched only when the turn actually
      // needs it. Same disclosure shape the skills index uses, applied to tool schemas.
      //
      // boundSources is the enforcement point, so an undeclared connection is not merely absent
      // from the index — asking for it by id returns nothing either.
      const SRC = "derive://sources"
      if (short_id === SRC || short_id.startsWith(`${SRC}/`)) {
        const ws = await resolveWs(workspace)
        if ("error" in ws) return err(ws.error)
        const bound = await boundSources(ctx.meta, ws.org, actingFor?.id ?? ownerId)
        const id = short_id === SRC ? "" : short_id.slice(SRC.length + 1)
        if (!id) {
          if (bound.length === 0)
            return json({
              uri: short_id,
              sources: [],
              note: "No connected sources are available to chat here. An admin declares them in workspace settings; connecting a server does not by itself expose it to a conversation.",
            })
          return json({
            uri: short_id,
            sources: bound.map((b: { id: string; toolkit: string; kind: string }) => ({
              id: b.id,
              name: b.toolkit,
              kind: b.kind,
              read: `derive://sources/${b.id}`,
            })),
            note: "Read one to see its tools, then invoke with the call tool.",
          })
        }
        const { tools } = await sourceTools(
          ctx.meta,
          ws.org,
          actingFor?.id ?? ownerId,
          ctx.deps.encryptionKey,
          id,
        )
        if (tools.length === 0)
          return err(
            `No source "${id}" is available to chat here. Read derive://sources for the ones that are.`,
          )
        return json({
          uri: short_id,
          source: id,
          // Descriptions and schemas are SERVER-SUPPLIED text. They are data for the model to
          // read, never instructions to follow — the same footing as a document's contents.
          tools: tools.map((t) => ({
            name: t.def.name,
            description: t.def.description,
            params: t.def.params,
          })),
        })
      }
      const SK = "derive://skills/"
      if (short_id === "derive://skills") {
        const t = await resolveWs(workspace)
        if ("error" in t) return err(t.error)
        const catalog = await skillsCatalog(ctx, t.org, actingFor?.id ?? agent.id)
        return json({
          uri: short_id,
          ...catalog,
          ...(catalog.truncated ? { next: "Use find skills:true for the full set." } : {}),
        })
      }
      if (short_id.startsWith(SK)) {
        const name = short_id.slice(SK.length)
        const skill = CORE_SKILLS.find((s) => s.name === name)
        if (skill) return json({ uri: short_id, mimeType: "text/markdown", content: skill.body })
        // A workspace skill rides the same prefix by short id. Core names win; short
        // ids are exactly 8 base36 chars, so the lookup order settles the one
        // collision a name like "contexts" could ever pose. Access is the ordinary
        // artifact reach — tenancy, roaming, and takedowns identical to a plain read.
        const r = await reach(name, workspace)
        if (r && "error" in r) return err(r.error)
        if (r && r.a.current_content_type === SKILL_CONTENT_TYPE) {
          const reading = await skillReading(ctx, r.a)
          if (reading)
            return json({
              uri: short_id,
              mimeType: "text/markdown",
              // Clipped like every other content read — a SKILL.md can arrive by
              // 100MB zip upload, and this response has no outline rung to fall to.
              content: clip(reading.body + skillFilesFooter(r.a.short_id, reading.others)),
            })
        }
        return err(
          `No skill "${name}". Core: ${CORE_SKILLS.map((s) => s.name).join(", ")}; workspace skills: read derive://skills for the catalog.`,
        )
      }
      // The deck starter, resolved here as well as via MCP resources — the skill that
      // points at it is read through this same tool on clients without resource support,
      // so a steer to it must never be a dead link.
      if (short_id.startsWith("derive://decks/")) {
        if (short_id !== "derive://decks/template")
          return err(
            `No deck resource "${short_id}". The starter is derive://decks/template; the guide is derive://skills/decks.`,
          )
        return json({ uri: short_id, mimeType: "text/html", content: DECK_TEMPLATE })
      }
      if (short_id.startsWith("derive://videos/")) {
        if (short_id !== "derive://videos/template")
          return err(
            `No video resource "${short_id}". The starter is derive://videos/template; the guide is derive://skills/videos.`,
          )
        return json({ uri: short_id, mimeType: "text/html", content: VIDEO_TEMPLATE })
      }
      // The built-in catalog is gone; a client on a cached instruction still asks for it.
      if (short_id.startsWith("derive://templates/"))
        return err(
          "Built-in templates were retired. Templates are artifacts: find with templates:true lists them, and read takes a result's short_id.",
        )
      const authoredRef = parseTemplateLibraryUri(short_id)
      if (short_id === TEMPLATE_LIBRARY_CATALOG_URI || authoredRef) {
        const canReadLibrary = async (library: Parameters<typeof canReadTemplateLibrary>[0]) => {
          const workspaceReachable = !!ownerId && inGrant(library.org_id)
          const member = workspaceReachable
            ? await ctx.meta.getMembership(library.org_id, ownerId as string)
            : null
          return canReadTemplateLibrary(library, {
            ownerId,
            workspaceReachable,
            isMember: !!member,
          })
        }
        if (short_id === TEMPLATE_LIBRARY_CATALOG_URI) {
          const ws = await resolveWs(workspace)
          if ("error" in ws) return err(ws.error)
          const [publicLibraries, workspaceLibraries, privateLibraries] = await Promise.all([
            ctx.meta.listTemplateLibraries({ scope: "public", limit: 101 }),
            ctx.meta.listTemplateLibraries({ orgId: ws.org, scope: "workspace", limit: 101 }),
            ownerId
              ? ctx.meta.listTemplateLibraries({
                  orgId: ws.org,
                  scope: "private",
                  createdBy: ownerId,
                  limit: 101,
                })
              : [],
          ])
          const allLibraries = [...privateLibraries, ...workspaceLibraries, ...publicLibraries]
            .filter(
              (library, index, all) =>
                all.findIndex((candidate) => candidate.id === library.id) === index,
            )
            .sort((a, b) => b.created_at.localeCompare(a.created_at))
          const libraries = allLibraries.slice(0, 100)
          const counts = await ctx.meta.countTemplateLibraryEntries(
            libraries.map((library) => library.id),
          )
          return json({
            uri: short_id,
            truncated: allLibraries.length > libraries.length,
            next:
              allLibraries.length > libraries.length
                ? "Use find with templates:true to search every library entry."
                : undefined,
            libraries: libraries.map((library) => ({
              id: library.id,
              title: library.title,
              description: library.description,
              scope: library.scope,
              entry_count: counts[library.id] ?? 0,
              read: templateLibraryUri(library.id),
            })),
          })
        }
        const { libraryId, entryId } = authoredRef as NonNullable<typeof authoredRef>
        const library = await ctx.meta.getTemplateLibrary(libraryId)
        if (!library || !(await canReadLibrary(library)))
          return err(
            `No template library "${libraryId}" you can reach. Read derive://template-libraries to find one.`,
          )
        const entries = await ctx.meta.listTemplateLibraryEntries(library.id)
        if (!entryId)
          return json({
            uri: short_id,
            id: library.id,
            title: library.title,
            description: library.description,
            scope: library.scope,
            entries: entries.map((entry) => ({
              ...templateLibraryEntryJson(entry),
              read: templateLibraryUri(library.id, entry.id),
            })),
          })
        const entry = entries.find((candidate) => candidate.id === entryId)
        if (!entry) return err(`No starter "${entryId}" in template library "${libraryId}".`)
        const source = await ctx.sourceText({
          blob_key: entry.source_blob_key,
          content_type: entry.source_content_type,
        })
        if (source === null) return err(`Starter "${entry.title}" is unavailable.`)
        const metadata = templateLibraryEntryJson(entry)
        return json({
          uri: short_id,
          ...metadata,
          starter: {
            source,
            filename: `${entry.id}.${entry.format}`,
            mime_type: entry.source_content_type,
            message: `Created from ${library.title}/${entry.title} · source v${entry.source_version}`,
          },
        })
      }
      // A CONTEXT id or name loads the PACKAGE rather than a document: manifest inline,
      // skills and sources as pointers. Same gate as asking — askableContexts is the
      // per-human canUserAskContext check `find` uses — so reading can never surface a
      // context the caller could not already see, and no second access path exists.
      // Returns null when this ref is not a context the caller can reach, so the artifact
      // path stays in charge: only a `ctx_` id short-circuits, and a bare NAME is tried
      // only after the artifact lookup misses (below), so a context can never shadow a doc.
      const contextPackage = async () => {
        if (!actingFor)
          return err(
            "Contexts need a signed-in user. Reconnect with an OAuth login to read or use them.",
          )
        const t = await resolveWs(workspace)
        if ("error" in t) return err(t.error)
        const rows = await askableContexts(t.org, actingFor.id)
        const hit =
          rows.find(({ x }) => x.id === short_id) ??
          rows.find(({ x }) => x.name.toLowerCase() === short_id.trim().toLowerCase())
        if (!hit) return null
        const pkg = await assembleContextPackage(
          ctx.meta,
          hit.x,
          hit.manifest,
          (v) => ctx.sourceText(v),
          runnerOnline(hit.x),
        )
        return json({
          ...pkg,
          how: "The Context package, opened progressively: its instructions are loaded; skills and sources are pointers — read one by its short_id when a task needs it. To use the Context for work, call use({context, instruction}).",
        })
      }
      if (short_id.startsWith("ctx_")) {
        const pkg = await contextPackage()
        return (
          pkg ??
          err(
            `No Context "${short_id}" you can reach here. Call find to list the Contexts you may use.`,
          )
        )
      }
      const BP = "derive://brandprint/"
      let docId = short_id
      if (short_id.startsWith(BP)) {
        const seg = short_id.slice(BP.length)
        if (seg === "reference")
          return json({ uri: short_id, mimeType: "text/markdown", content: BRANDPRINT_REFERENCE })
        if (seg === "template")
          return json({ uri: short_id, mimeType: "text/html", content: BRANDPRINT_TEMPLATE })
        if (seg === "profile") {
          if (!(bpProfile?.state === "live" && profileArt))
            return err(
              "This workspace has no live brand profile yet. Read derive://brandprint/reference and derive://brandprint/template, build the profile, then publish it to derive://brandprint/profile (an Admin's first publish there scaffolds it; publishing opens a review round for the person).",
            )
          const pv = await ctx.meta.getVersion(profileArt.id, profileArt.current_version)
          const body = pv ? await ctx.sourceText(pv) : null
          return json({
            uri: short_id,
            mimeType: "text/html",
            version: profileArt.current_version,
            content: body ?? "",
          })
        }
        docId = seg
      }
      // Opted into the world link: a public artifact outside the grant reads at viewer.
      const r = await reach(docId, workspace, { public: true })
      if (r && "error" in r) return err(r.error)
      // A bare name that matches no artifact may still name a CONTEXT — tried only here,
      // after the artifact lookup, so a context named like a doc can never shadow it.
      if (!r) return (await contextPackage()) ?? notFound(docId)
      const a = r.a
      // A skill's default version is current, like every read, and it applies to
      // EVERY rung — body, sections, outline, render — so the footer's "read this
      // file" suggestions can't fetch a different version than the body they rode
      // in on. An explicit `version` always wins.
      const n = version ?? a.current_version
      if (n < 1 || n > a.current_version)
        return err(`No version ${n} for "${short_id}" — it has versions 1..${a.current_version}.`)
      if (r.public && !versionOpenToWorld(a, n)) return historyNotPublic(short_id, a)
      const v = await ctx.meta.getVersion(a.id, n)
      if (!v) return err(`Version ${n} of "${short_id}" is unavailable.`)
      const url = artifactUrl(ctx.deps.baseUrl, a)

      // The render rung: the version's screenshot, so an agent SEES what it shipped.
      // The preview pipeline computes all three variants per publish (previews.ts);
      // this surfaces whichever one was asked for. Each lives on its own
      // key/status/error triple, so "full"/"marked" failing never blocks "top" (the
      // OG crop og:image unfurls depend on) and vice versa.
      if (render) {
        // `map`/`node` belong here too: this branch runs BEFORE the map rung below, so its
        // own guard against `render` never fires. Found on the preview — read(map, render)
        // silently returned a screenshot to a caller who asked for the structure.
        if (section || lines || wantMap || node || focus)
          return err(
            "`render` is a view of the whole version — pass it alone (with `version` for history).",
          )
        const label =
          render === "top"
            ? "the top of the page, 1200x630"
            : render === "full"
              ? "the whole page"
              : "the whole page, with the region map's @N refs drawn on it"
        let variant = pickVariant(v, render)
        // NO RENDERER ON THIS INSTANCE — decided before anything below waits for, re-queues,
        // or advises a retry on a screenshot that is never coming. It short-circuits three
        // paths at once: the self-heal (which would flip a `failed` variant to a PERMANENT
        // `pending`, since the re-queue behind it is a no-op here), the wait loop (which
        // would burn the caller's whole `wait` budget), and the "try again shortly" ending.
        // An ALREADY-STORED shot still serves: previews may have been on when it rendered
        // and switched off since, and that picture is still the truth about the page.
        // A variant that already FAILED keeps its reason. Previews may have been on when it
        // ran and switched off since, and "this instance renders nothing" would then discard
        // a true fact about the page (a font that never loaded, a layout that timed out) in
        // favour of a fact about the deployment. Both are said, in that order.
        // The renderer's error text is the instance's own; a reader without a seat gets
        // the fact of the failure only.
        const why = !r.public && variant.error ? ` (${variant.error})` : ""
        if (!ctx.deps.renderPreviews && !(variant.status === "ready" && variant.key))
          return err(
            rendersOff(
              variant.status === "failed"
                ? `The render:${render} of "${short_id}" v${n} failed${why}, and a fresh one`
                : `The render:${render} of "${short_id}" v${n}`,
              url,
            ),
          )
        // SELF-HEAL on read: a dead-lettered render (a transient storage/browser
        // error that exhausted its retries) used to demand a no-op republish just to
        // re-render. Re-queue it right here instead — reset the variant to pending so
        // the wait loop below can collect the fresh result in this same call, and so
        // a second read doesn't double-enqueue a still-failed-looking row. Bounded:
        // one re-queue per read call; the job keeps its own MAX_ATTEMPTS dead-letter.
        let requeued = false
        // ONLY for the CURRENT version. The render worker discards a job whose version has
        // been superseded (previews.ts marks it done without rendering it), so re-queueing
        // an older one would flip `failed` to `pending` PERMANENTLY: nothing ever renders
        // it, and the heal can't fire again because it only triggers on `failed`. That
        // trades an honest error message for "not ready yet, try again shortly" forever.
        // An old version keeps its failure, which is the truthful answer. The world link
        // never re-queues: a reader with no seat serves only what has rendered, as the
        // anonymous embed does.
        if (variant.status === "failed" && n === a.current_version && !r.public) {
          // Use the shared notifier rather than enqueueing directly: on Workers it also
          // pokes the PreviewRenderer DO, so this read's wait loop can observe the repair
          // instead of depending on a later cron tick.
          await ctx.notifyRender(a, n)
          if (render === "top")
            await ctx.meta.setVersionPreview(a.id, n, { preview_status: "pending" })
          else await ctx.meta.setVersionPreviewVariant(a.id, n, render, { status: "pending" })
          variant = { ...variant, status: "pending" }
          requeued = true
        }
        // Long-poll: the screenshot lands a few seconds after a publish. When it's neither
        // ready nor failed and the caller passed `wait`, block up to that many seconds
        // (max 30), re-reading the version, before returning the not-ready message — a
        // bounded retry loop so the agent gets the render in one call after a fresh push.
        if (
          wait &&
          !r.public &&
          !(variant.status === "ready" && variant.key) &&
          variant.status !== "failed"
        ) {
          const deadline = Date.now() + Math.min(Math.max(wait, 0), 30) * 1000
          while (
            Date.now() < deadline &&
            !(variant.status === "ready" && variant.key) &&
            variant.status !== "failed"
          ) {
            await sleep(Math.min(1500, Math.max(0, deadline - Date.now())))
            const refreshed = await ctx.meta.getVersion(a.id, n)
            if (refreshed) variant = pickVariant(refreshed, render)
          }
        }
        if (variant.status === "ready" && variant.key) {
          const shot = await ctx.blobs.get(variant.key)
          if (shot) {
            if (shot.length > IMAGE_INLINE_MAX)
              return json({
                short_id,
                version: n,
                render: "ready",
                bytes: shot.length,
                note: `Too large to inline over MCP — open ${url} to view the page.`,
              })
            return {
              content: [
                {
                  type: "text" as const,
                  text: `render:${render} of "${short_id}" v${n} — ${label} (${shot.length} bytes), as a viewer sees it. The source is untouched; use read/search for the text.`,
                },
                {
                  type: "image" as const,
                  data: toBase64(shot),
                  // SNIFFED, not assumed. Every variant is PNG today, but this used to be
                  // hardcoded, so the label was a claim about the pipeline rather than a
                  // reading of the bytes — and it would go quietly wrong the day any
                  // variant is stored in another format.
                  mimeType: sniffImageType(shot) ?? "image/png",
                },
              ],
            }
          }
        }
        if (variant.status === "failed")
          return err(
            `The render:${render} of "${short_id}" v${n} failed${requeued ? " again on a re-queued attempt" : ""}${why} — the page may still be fine; open ${url} to check. ` +
              // Only the current version re-renders: the worker discards a job for a
              // superseded one, so promising a retry here would be advice that silently
              // does nothing. Say what actually works instead.
              (r.public
                ? "It is not re-rendered for a reader without a seat in its workspace."
                : n === a.current_version
                  ? "Reading again re-queues a fresh render."
                  : `This is an old version, and only v${a.current_version} re-renders — read it without \`version\` to retry.`),
          )
        if (requeued)
          return err(
            `The render:${render} of "${short_id}" v${n} had failed${why} — a fresh render was just re-queued. Call read again with \`wait\` (seconds, max 30) to collect it.`,
          )
        return err(
          `The render:${render} of "${short_id}" v${n} isn't ready yet — screenshots are computed a few seconds after publish. Try again shortly${r.public ? "" : ", or pass `wait` (seconds, max 30) to block for it"}.`,
        )
      }
      // The data rung: a version's structured facts, queried instead of re-parsed. A
      // whole-version view like `render`, so it can't combine with a within-doc selector.
      if (data !== undefined) {
        if (section || lines || render || focus)
          return err(
            "`data` reads a version's stored facts — pass it alone (with `version` for history), not with section/lines/render/focus.",
          )
        // The TREND read: one slot across a range of versions, in one call and one query.
        // Versions are already the time axis, so this is the whole reason facts exist —
        // "how did this move over thirty days" without fetching thirty versions.
        if (versions !== undefined) {
          if (data === "*")
            return err(
              'Name a single slot to read across versions (data:"checks"); `data:"*"` lists one version\'s facts.',
            )
          const range = parseVersionRange(versions, a.current_version)
          if (!range)
            return err(
              `Bad \`versions\` "${versions}" for "${short_id}" (it has 1..${a.current_version}) — use "1-30", "12", "20-", or "all".`,
            )
          // The same clamp the raw series route applies to anonymous readers.
          if (r.public && !a.public_history) range.from = range.to = a.current_version
          const rows = await ctx.meta.getVersionDataSeries(
            a.id,
            data,
            range.from,
            range.to,
            DATA_SERIES_MAX + 1,
          )
          const truncated = rows.length > DATA_SERIES_MAX
          const kept = truncated ? rows.slice(0, DATA_SERIES_MAX) : rows
          const span = range.to - range.from + 1
          const missing = span - kept.length
          return json({
            short_id,
            fact: data,
            versions: `${range.from}-${range.to} of ${a.current_version}`,
            count: kept.length,
            series: kept.map((r) => ({
              n: r.n,
              at: r.created_at,
              // Stored JSON was validated at publish, so the parsed value is the useful
              // shape; the raw text is the honest fallback if a row ever predates that.
              data: safeJson(r.json),
            })),
            ...(truncated
              ? {
                  note: `More than ${DATA_SERIES_MAX} versions in this range carry "${data}" — this is the oldest ${DATA_SERIES_MAX}. Narrow the range (e.g. versions:"${range.to - DATA_SERIES_MAX + 1}-${range.to}") for the most recent.`,
                }
              : missing > 0
                ? {
                    // A derived name is never "omitted": nobody embeds it. Series reads
                    // serve STORED rows only (a 200-version series must not become 200
                    // blob reads), so old versions are simply underived until each is
                    // read singly — which is the honest instruction to give here.
                    note: isDerivedFactName(data)
                      ? `${missing} version(s) in this range have no stored "${data}". Derived facts fill on a single-version read (read the version without \`versions\`), never in a series — a series must not trigger one derivation per version.`
                      : `${missing} version(s) in this range carry no "${data}" slot — they predate facts or omitted the block.`,
                  }
                : {}),
          })
        }
        if (data === "*") {
          const rows = await ctx.meta.getVersionData(a.id, n)
          return json({
            short_id,
            version: n,
            // One artifact's own inventory is not the adoption surface, so derived rows
            // list here — marked, never mistakable for the author's. The WORKSPACE
            // catalog (find data:"*") is the adoption substrate and excludes them.
            facts: rows.map((r) => ({
              fact: r.slot,
              bytes: r.size_bytes,
              ...(isDerivedFactName(r.slot) ? { derived: true } : {}),
            })),
            ...(rows.length ? {} : { note: absenceNote(null, v, `Version ${n} of "${short_id}"`) }),
          })
        }
        let rows = await ctx.meta.getVersionData(a.id, n, data)
        // LAZY DERIVATION — bounded to exactly here, the single-version named read. A
        // $name that is missing (version predates derivation) or stale (its gen predates
        // THAT deriver's current generation — per-slot, so a $stats bump never re-derives
        // the corpus's $links) recomputes from the version's own bytes: one blob, one
        // pass, value returned now, rows persisted off the response. Series reads and the
        // raw routes serve stored rows only — a 200-version series must never become 200
        // blob reads in one request, and anonymous traffic must not command compute. The
        // world link over MCP is anonymous traffic: stored rows only, nothing persisted.
        let lazyFilled = false
        if (
          !r.public &&
          isDerivedFactName(data) &&
          (!rows[0] || rows[0].gen !== derivedGen(data))
        ) {
          const fresh = await lazyDeriveVersion(ctx, a.id, v, n)
          if (fresh) {
            rows = fresh.filter((r) => r.slot === data)
            lazyFilled = true
          }
        }
        const row = rows[0]
        if (!row) {
          if (r.public && isDerivedFactName(data))
            return err(
              `"${short_id}" v${n} has no stored "${data}". Derived facts are computed for readers with a seat in its workspace; the world link serves only what is stored.`,
            )
          const all = await ctx.meta.getVersionData(a.id, n)
          return err(
            absenceNote(
              data,
              v,
              `"${short_id}" v${n}`,
              all.map((r) => r.slot),
            ),
          )
        }
        // The consumption instrument: the meter counts EMISSION, and adoption is
        // emission AND consumption. One line answers "does anyone query any of this"
        // for the whole layer at once — the same tripwire pattern (#574's
        // derived_view_read) that is the only reason #433 ever got a schedule.
        log.info("fact_read", {
          name: row.slot,
          derived: isDerivedFactName(row.slot),
          surface: "read",
          lazy_fill: lazyFilled,
        })
        const stale = staleNote()
        return json({
          short_id,
          version: n,
          fact: row.slot,
          data: safeJson(row.json),
          ...(stale ? { note: stale } : {}),
        })
      }
      // Reject incompatible part selectors before any source blob read. These checks also
      // keep the error text stable for focus, whose branch used to do the same validation
      // only after a potentially multi-megabyte source load.
      if (focus && (section || lines || wantMap || node))
        return err(
          "Pass `focus` alone (with `format` and `version`), not with another part selector.",
        )
      if (wantMap && node) return err("Pass `map` OR `node`, not both.")
      if ((wantMap || node) && (section || lines || render))
        return err("`map`/`node` address the document's parts — pass with `version` only.")

      // Publish derivation already stores the bounded wire map. Serve it before loading and
      // parsing the source. Missing, stale, or corrupt cache rows fall
      // through to the source path below, so authored bytes remain the authority.
      if (wantMap) {
        const row = (await ctx.meta.getVersionData(a.id, n, "$map"))[0]
        const stored = row?.gen === derivedGen("$map") ? storedMapOf(row.json) : null
        if (stored)
          return json({
            short_id,
            title: a.title,
            version: n,
            kind: stored.kind,
            format: formatLabel(v.content_type, fmt),
            url,
            bytes: stored.bytes,
            nodes: stored.nodes,
            ...(stored.truncated ? { truncated: true } : {}),
            ...(stored.total !== undefined ? { total: stored.total } : {}),
            note: "Read one part with read(node:\"<ref>\"), format:'html' for its exact source. Same JSON at /raw/<short_id>/data/$map.json.",
          })
      }
      const manifest = await manifestOf(ctx, v)

      if (!manifest) {
        // Single-file artifact.
        const src = (await ctx.sourceText(v)) ?? ""
        const ct = v.content_type
        // A linked bundle's logical grouping rides every ordinary read, not only a
        // special data query. Keep this orientation compact; the full, inspectable
        // topology stays available as the authored bundle-manifest fact.
        let linkedBundleMeta: Record<string, string> = {}
        if (ct === LINKED_BUNDLE_CONTENT_TYPE) {
          const row = (await ctx.meta.getVersionData(a.id, n, LINKED_BUNDLE_FACT))[0]
          if (row) {
            try {
              const checked = validateLinkedBundle(JSON.parse(row.json))
              if (checked.manifest) {
                const clean = (value: string) => value.replace(/\s+/g, " ").trim()
                const members = checked.manifest.members.slice(0, 50)
                linkedBundleMeta = {
                  bundle_purpose: clean(checked.manifest.purpose),
                  bundle_members: `${members
                    .map(
                      (member) =>
                        `${member.id}=${clean(member.label)} (${member.ref})${member.role ? ` [${clean(member.role)}]` : ""}`,
                    )
                    .join(
                      " | ",
                    )}${checked.manifest.members.length > members.length ? ` | +${checked.manifest.members.length - members.length} more` : ""}`,
                  ...(checked.manifest.diagrams?.length
                    ? {
                        bundle_diagrams: checked.manifest.diagrams
                          .map((diagram) => `${diagram.type}:${clean(diagram.title)}`)
                          .join(" | "),
                        ...(checked.manifest.diagrams.some((diagram) =>
                          diagram.nodes.some((node) => node.state),
                        )
                          ? {
                              bundle_state: checked.manifest.diagrams
                                .flatMap((diagram) =>
                                  diagram.nodes
                                    .filter((node) => node.state)
                                    .map((node) => {
                                      const actionable =
                                        node.state === "active" ||
                                        node.state === "waiting" ||
                                        node.state === "blocked"
                                      const tier = node.tier ?? diagram.tier
                                      const confidence =
                                        actionable && node.confidence
                                          ? ` [confidence:${node.confidence.level}; ${clean(node.confidence.basis)}]`
                                          : ""
                                      return `${diagram.id}.${node.id}=${node.state}${node.basis_version ? `@v${node.basis_version}` : ""}${tier ? ` [tier:${tier}]` : ""}${node.role ? ` [role:${clean(node.role)}]` : ""}${confidence}`
                                    }),
                                )
                                .join(" | "),
                              ...(checked.manifest.diagrams.some((diagram) =>
                                diagram.nodes.some(
                                  (node) =>
                                    (node.state === "active" ||
                                      node.state === "waiting" ||
                                      node.state === "blocked") &&
                                    node.help?.needed &&
                                    (node.help.question || node.help.can_continue),
                                ),
                              )
                                ? {
                                    bundle_help: checked.manifest.diagrams
                                      .flatMap((diagram) =>
                                        diagram.nodes
                                          .filter(
                                            (node) =>
                                              (node.state === "active" ||
                                                node.state === "waiting" ||
                                                node.state === "blocked") &&
                                              node.help?.needed &&
                                              (node.help.question || node.help.can_continue),
                                          )
                                          .map(
                                            (node) =>
                                              `${diagram.id}.${node.id}: ${node.help?.question ? `question: ${clean(node.help.question)}` : ""}${node.help?.question && node.help?.can_continue ? "; " : ""}${node.help?.can_continue ? `can continue: ${clean(node.help.can_continue)}` : ""}`,
                                          ),
                                      )
                                      .join(" | "),
                                  }
                                : {}),
                            }
                          : {}),
                      }
                    : {}),
                  bundle_next: `Start with catch_up(short_id:"${short_id}") so open general and pinned feedback enters the run. Read the full topology with read(short_id:"${short_id}", data:"${LINKED_BUNDLE_FACT}"). Keep member artifacts independent; revise this bundle only when its purpose, membership, or diagrams change.`,
                }
              }
            } catch {
              // Publishing validates the row. If a legacy/corrupt row exists, reading
              // the authored document still wins over failing its orientation garnish.
            }
          }
        }
        const meta = {
          short_id,
          title: a.title,
          version: `${n}${n === a.current_version ? " (current)" : ""}`,
          kind: a.kind,
          format: formatLabel(ct, fmt),
          url,
          ...linkedBundleMeta,
        }
        // Focus read: collapse literal locate -> read surrounding part into one call. It
        // uses the same derived map as `map`/`node`, so every returned match is already an
        // address the caller can reuse for an exact-source read or a scoped edit.
        if (focus) {
          let structure: DocMap
          try {
            structure = structureOf(v, src, ct ?? "text/html")
          } catch (e) {
            return err(e instanceof Error ? e.message : "This document's structure can't be read.")
          }
          const matcher = searchMatcher(focus, false)
          let matchCount = 0
          const matches: Array<{ target: DocMap["nodes"][number]; body: string }> = []
          for (const target of structure.nodes) {
            const sourcePart = src.slice(target.start, target.end)
            // `focus` asks for literal document text. Markdown is the response format, not
            // the match domain: generated `#`, `*`, link, and table syntax must not split a
            // phrase a viewer sees as contiguous. The visible-text projection is also much
            // cheaper than formatting every non-match as Markdown. Exact-source focus keeps
            // its existing HTML search contract.
            const searchBody = present(sourcePart, ct, fmt === "markdown" ? "text" : fmt)
            matcher.lastIndex = 0
            if (!matcher.test(searchBody)) continue
            matchCount += 1
            // Count every match so truncation stays exact, but retain only the bodies
            // the response can return. A common term in a long document must not hold a
            // second readable copy of the whole document in Worker memory.
            if (matches.length < FOCUS_MATCH_MAX)
              matches.push({
                target,
                body: fmt === "markdown" ? present(sourcePart, ct, fmt) : searchBody,
              })
          }
          return json({
            ...meta,
            focus,
            count: matchCount,
            matches: matches.map(({ target, body }) => ({
              node: target.ref,
              type: target.type,
              chars: body.length,
              ...(target.title ? { title: target.title } : {}),
              body: clipFocusBody(body),
            })),
            ...(matchCount > FOCUS_MATCH_MAX
              ? { truncated: true, more_matches: matchCount - FOCUS_MATCH_MAX }
              : {}),
            next: matchCount
              ? `Use read(node:"<ref>", format:"html") only if you need exact source for an edit.`
              : `No matching part. Try one neighbouring literal, or use find(short_id:"${short_id}", query:"${focus}") for line-level search.`,
          })
        }
        // The map rung: the document's addressable parts. Read before working on part of
        // a big doc — it is the cheap structural view the full-document read is not, and
        // every ref it hands back is what `node` (and, next, a scoped edit) takes.
        if (wantMap || node) {
          let structure: DocMap
          try {
            structure = structureOf(v, src, ct ?? "text/html")
          } catch (e) {
            return err(e instanceof Error ? e.message : "This document's structure can't be read.")
          }
          if (wantMap)
            return json({
              ...meta,
              ...mapJson(structure, n),
              // Steering lives in the RESPONSE, not in the tool description: the surface
              // teaches itself at the moment it is used, and costs nothing to sessions
              // that never ask for it.
              note: "Read one part with read(node:\"<ref>\"), format:'html' for its exact source. Same JSON at /raw/<short_id>/data/$map.json.",
            })
          const target = resolveNode(structure, node as string)
          if (!target)
            return err(
              `No node "${node}" in "${short_id}" v${n}. Refs here: ${refsOf(structure).join(", ")}.`,
            )
          const slice = src.slice(target.start, target.end)
          return json({
            ...meta,
            node: target.ref,
            type: target.type,
            bytes: target.end - target.start,
            ...(target.title ? { title: target.title } : {}),
            body: clip(present(slice, ct, fmt)),
          })
        }

        if (lines) {
          if (section && section !== "*")
            return err("Pass `lines` OR `section`, not both — windowing applies to the whole doc.")
          const body = present(src, ct, fmt)
          const all = body.split("\n")
          const range = parseLineRange(lines, all.length)
          if (!range)
            return err(
              `Bad \`lines\` "${lines}" for "${short_id}" v${n} (1..${all.length}) — use "40-120", "40", or "40-".`,
            )
          const windowed = all.slice(range.from - 1, range.to).join("\n")
          return doc(
            {
              ...meta,
              lines: `${range.from}-${range.to} of ${all.length}`,
              chars: windowed.length,
            },
            clip(windowed),
          )
        }
        // Region read: "@N" pulls the Nth landmark region from the page map, so a
        // headless page's map is directly readable, not just orientation.
        const regionRef = section?.match(/^@(\d+)$/)
        if (regionRef) {
          const idx = Number(regionRef[1])
          const slice = landmarkSlice(src, idx)
          if (slice === null) {
            const count = landmarksOf(src, ct).length
            return err(
              count
                ? `No region @${idx} in "${short_id}" — it has ${count} region(s), @1..@${count}. Read with no \`section\` for the map.`
                : `"${short_id}" has no landmark regions — read a heading \`section\`, a \`lines\` range, or the whole doc.`,
            )
          }
          const body = present(slice, ct, fmt)
          const count = landmarksOf(src, ct).length
          return doc(
            { ...meta, section: `@${idx} of ${count} regions`, chars: body.length },
            clip(body),
          )
        }
        if (section && section !== "*") {
          const slice = sectionOf(src, ct, section)
          if (slice === null) {
            const slugs = outlineOf(src, ct).map((s) => s.slug)
            return err(
              slugs.length
                ? `No section "${section}" in "${short_id}" v${n} — sections: ${slugs.join(", ")}.`
                : `"${short_id}" has no headings to section by — read it whole (omit \`section\`).`,
            )
          }
          // Also feeds clipDoc's steer below — a single section can itself be huge
          // (e.g. the last one, which runs to </body>), so it needs the same
          // MAX_CHARS ceiling the whole-doc path gets, not an unbounded return.
          const outline = outlineOf(src, ct)
          const i = outline.findIndex((s) => s.slug === section)
          const body = present(slice, ct, fmt)
          return doc(
            {
              ...meta,
              section: `${section} (${i + 1} of ${outline.length})`,
              chars: body.length,
            },
            clipDoc(body, outline),
          )
        }
        // Tripwire (evidence for the derived-view cache decision, #433): time the
        // HTML→markdown conversion on the whole-doc read path — the exact recompute that
        // PR would cache — and log source size + cost + whether it crosses that PR's
        // 150K-char gate. One line, no schema; a week of these numbers says whether the
        // cache is worth landing or closing. Only for HTML sources (markdown `present` is
        // a near-noop and would just be log noise).
        const tConv = Date.now()
        const body = present(src, ct, fmt)
        if (isHtmlLike(ct))
          log.info("derived_view_read", {
            short_id,
            chars: src.length,
            ms: Date.now() - tConv,
            fmt,
            gate_150k: src.length >= 150_000,
          })
        if (!section && body.length > FULL_DOC_MAX) {
          const outline = outlineOf(src, ct)
          if (outline.length)
            return json({
              short_id,
              title: a.title,
              kind: a.kind,
              version: n,
              source: ct,
              format: fmt,
              doc_chars: body.length,
              url,
              sections: outline,
              next: 'Large document — call read again with a `section` slug for just that part, or section:"*" for the full clipped text. To revise it, publish with `edits` instead of resending content.',
            })
          // No headings — a designed, headless HTML page (dashboard, card grid) still
          // has landmark structure. Return that map so the agent can search/window in
          // rather than blindly dumping a clipped wall of text.
          const regions = landmarksOf(src, ct)
          if (regions.length)
            return json({
              short_id,
              title: a.title,
              kind: a.kind,
              version: n,
              source: ct,
              format: fmt,
              doc_chars: body.length,
              url,
              regions: regions
                .slice(0, PAGE_MAP_MAX)
                .map((region, i) => ({ ref: `@${i + 1}`, ...region })),
              ...(regions.length > PAGE_MAP_MAX
                ? { more_regions: regions.length - PAGE_MAP_MAX }
                : {}),
              next: 'This page has no headings — it is mapped by region above. Read a region directly with its `ref` (e.g. section:"@1"), or `search` for a term. section:"*" forces the full clipped text.',
            })
          // Truly unstructured — fall through to a plain (clipped) return, reusing the
          // already-computed (empty) outline instead of asking again.
          return doc({ ...meta, chars: body.length }, clipDoc(body, outline))
        }
        // Under FULL_DOC_MAX: clipDoc's MAX_CHARS ceiling is far above this body's
        // size, so it can never truncate — skip computing an outline it won't use.
        const outline = body.length > MAX_CHARS ? outlineOf(src, ct) : []
        return doc({ ...meta, chars: body.length }, clipDoc(body, outline))
      }

      // Bundle.
      const pages = Object.keys(manifest.files).map(cleanPath)
      if (focus)
        return err(
          "`focus` currently reads single-file artifacts. For a bundle, use find(short_id, query), then read its matching page path.",
        )
      // A skill reads as its document: the SKILL.md body, with the bundle's files
      // listed alongside. The common caller was just told to follow this procedure,
      // so the outline-first bundle default is the wrong rung here. Explicit
      // `section` still opens one file; naming any other version keeps the
      // ordinary bundle view.
      if (
        a.current_content_type === SKILL_CONTENT_TYPE &&
        !section &&
        !wantMap &&
        !node &&
        !lines &&
        n === a.current_version
      ) {
        const reading = await skillReading(ctx, a)
        // A giant SKILL.md keeps the ordinary outline path below — the same ceiling
        // whole-document reads honor — so this branch can never return megabytes.
        if (reading && reading.body.length <= FULL_DOC_MAX)
          return json({
            short_id,
            title: reading.name ?? a.title,
            kind: "skill",
            version: reading.version,
            url,
            content: reading.body,
            files: pages,
            next: 'Read one of the files with read(section:"<path>").',
          })
      }
      if (!section) {
        // Outline: every page, plus sizes + headings for the shallowest text pages
        // (each costs a blob read — the manifest has no sizes — so cap the sweep).
        const textPages = pages
          .filter((p) => isTextType(manifest.files[p]?.type ?? manifest.files[`/${p}`]?.type ?? ""))
          .sort((x, y) => x.split("/").length - y.split("/").length || x.localeCompare(y))
        const entry = cleanPath(manifest.entry)
        const inspect = [entry, ...textPages.filter((p) => p !== entry)].slice(0, 25)
        // The blob reads are independent — fetch them all at once instead of one
        // round trip at a time (up to 25 pages, otherwise serialized latency).
        const detailEntries = await Promise.all(
          inspect.map(
            async (p): Promise<[string, { chars: number; headings: OutlineSection[] }] | null> => {
              const file = manifest.files[p] ?? manifest.files[`/${p}`]
              if (!file) return null
              const bytes = await ctx.blobs.get(file.key)
              if (!bytes) return null
              const text_ = new TextDecoder().decode(bytes)
              return [
                p,
                {
                  chars: toMarkdown(text_, file.type).length,
                  headings: outlineOf(text_, file.type),
                },
              ]
            },
          ),
        )
        const detail = new Map(detailEntries.filter((e) => e !== null))
        return json({
          short_id,
          title: a.title,
          kind: "bundle",
          version: n,
          entry,
          url,
          pages: pages.map((p) => {
            const type = manifest.files[p]?.type ?? manifest.files[`/${p}`]?.type
            const d = detail.get(p)
            return {
              path: p,
              type,
              ...(d
                ? {
                    chars: d.chars,
                    headings: d.headings.map((h) => ({
                      slug: h.slug,
                      level: h.level,
                      text: h.text,
                    })),
                  }
                : {}),
            }
          }),
          next: "Call read again with a `section` (a page path above, optionally page.html#slug for one heading's part) for content.",
        })
      }

      // A page (optionally page#slug — split on the LAST '#'). "#*" forces the
      // page's full (clipped) content, the same bypass single-file section:"*" is.
      const hash = section.lastIndexOf("#")
      const pagePath = hash > 0 ? section.slice(0, hash) : section
      const rawSlug = hash > 0 ? section.slice(hash + 1) : null
      const slug = rawSlug === "*" ? null : rawSlug
      const forceFull = rawSlug === "*"
      const file = manifest.files[pagePath] ?? manifest.files[`/${cleanPath(pagePath)}`]
      if (!file) return err(`No page "${pagePath}" in "${short_id}". Pages: ${pages.join(", ")}.`)
      const bytes = await ctx.blobs.get(file.key)

      // An image page is an IMAGE, not text: inline it as a real image block (small
      // ones), or point at the served URL. Never decode PNG bytes as a string.
      if (baseType(file.type).startsWith("image/")) {
        const pageUrl = `${ctx.deps.baseUrl}/raw/${short_id}/v/${n}/${cleanPath(pagePath)}`
        const size = bytes?.length ?? 0
        if (!bytes || size > IMAGE_INLINE_MAX)
          return json({
            short_id,
            section: cleanPath(pagePath),
            type: file.type,
            bytes: size,
            url: pageUrl,
            note: "Too large to inline over MCP — open the url to view it.",
          })
        return {
          content: [
            {
              type: "text" as const,
              text: `${cleanPath(pagePath)} (${file.type}, ${size} bytes) — served at ${pageUrl}`,
            },
            { type: "image" as const, data: toBase64(bytes), mimeType: baseType(file.type) },
          ],
        }
      }

      const raw = bytes ? new TextDecoder().decode(bytes) : ""
      const isText = isTextType(file.type)
      const meta = {
        short_id,
        title: a.title,
        version: `${n}${n === a.current_version ? " (current)" : ""}`,
        kind: "bundle",
        url,
        type: file.type,
      }
      if (lines) {
        if (slug)
          return err("Pass `lines` OR a #slug, not both — windowing applies to a whole page.")
        const pageBody = isText ? present(raw, file.type, fmt) : raw
        const all = pageBody.split("\n")
        const range = parseLineRange(lines, all.length)
        if (!range)
          return err(
            `Bad \`lines\` "${lines}" for "${cleanPath(pagePath)}" (1..${all.length}) — use "40-120", "40", or "40-".`,
          )
        const windowed = all.slice(range.from - 1, range.to).join("\n")
        return doc(
          {
            ...meta,
            section: cleanPath(pagePath),
            lines: `${range.from}-${range.to} of ${all.length}`,
            chars: windowed.length,
          },
          clip(windowed),
        )
      }
      if (slug) {
        if (!isText)
          return err(`"${pagePath}" is ${file.type} — heading sections only apply to text pages.`)
        const slice = sectionOf(raw, file.type, slug)
        if (slice === null) {
          const slugs = outlineOf(raw, file.type).map((s) => s.slug)
          return err(
            slugs.length
              ? `No section "${slug}" in "${pagePath}" — sections: ${slugs.join(", ")}.`
              : `"${pagePath}" has no headings to section by — read the whole page.`,
          )
        }
        const outline = outlineOf(raw, file.type)
        const body = present(slice, file.type, fmt)
        return doc(
          {
            ...meta,
            section: `${cleanPath(pagePath)}#${slug}`,
            format: formatLabel(file.type, fmt),
            chars: body.length,
          },
          clipDoc(body, outline),
        )
      }
      // css/js/json/etc always return source — conversion only applies to text pages.
      const body = isText ? present(raw, file.type, fmt) : raw
      // Same outline-first threshold the single-file path applies: a bundle page can
      // be just as large as a standalone doc, so it gets the same treatment instead
      // of only ever cutting at the much higher MAX_CHARS ceiling below.
      if (isText && !slug && !forceFull && body.length > FULL_DOC_MAX) {
        const outline = outlineOf(raw, file.type)
        if (outline.length)
          return json({
            short_id,
            title: a.title,
            kind: "bundle",
            version: n,
            section: cleanPath(pagePath),
            source: file.type,
            format: fmt,
            doc_chars: body.length,
            url,
            sections: outline,
            next: `Large page — call read again with \`section\` set to "${cleanPath(pagePath)}#slug" for just that part, or "${cleanPath(pagePath)}#*" for the full clipped text.`,
          })
        const regions = landmarksOf(raw, file.type)
        if (regions.length)
          return json({
            short_id,
            title: a.title,
            kind: "bundle",
            version: n,
            section: cleanPath(pagePath),
            source: file.type,
            format: fmt,
            doc_chars: body.length,
            url,
            regions: regions.slice(0, PAGE_MAP_MAX),
            ...(regions.length > PAGE_MAP_MAX
              ? { more_regions: regions.length - PAGE_MAP_MAX }
              : {}),
            next: `This page has no headings — it is mapped by region above. Use \`search\` to find a term, then read with \`lines:"from-to"\` to window that part, or "${cleanPath(pagePath)}#*" for the full clipped text.`,
          })
        return doc(
          { ...meta, section: cleanPath(pagePath), chars: body.length },
          clipDoc(body, outline),
        )
      }
      const outline = isText && body.length > MAX_CHARS ? outlineOf(raw, file.type) : []
      return doc(
        {
          ...meta,
          section: cleanPath(pagePath),
          format: isText ? formatLabel(file.type, fmt) : file.type,
          chars: body.length,
        },
        clipDoc(body, outline),
      )
    },
  )
}
