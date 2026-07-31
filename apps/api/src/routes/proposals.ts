import {
  type AnyDocEdit,
  type ArtifactRecord,
  diffLines,
  EditError,
  type ProposalRecord,
  PublishError,
  propose,
} from "@derive/core"
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { Context } from "hono"
import type { BlankEnv } from "hono/types"
import type { AppContext } from "../context"
import { markAddressed, releaseAddressed } from "../lib/addressed"
import {
  EditConflictError,
  type MaterializedEdits,
  materializeEdits,
  parseBaseVersion,
} from "../lib/edits"
import { bail, fail, MAX_UPLOAD_BYTES, readJson, str } from "../lib/http"
import { approveProposalAction, requestChangesAction } from "../lib/proposal-actions"
import { DiffOp } from "../schemas"

/** Parse a comma-separated id list (the `addresses` multipart field). */
const idList = (raw: string | undefined): string[] =>
  (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)

/** Reviews: a proposal is a candidate version awaiting approval. A commenter
 *  proposes; an editor approves (it goes live) or requests changes. The Proposal
 *  response schema is the single source for the web client's type. */
export const proposalRoutes = (ctx: AppContext) => {
  const {
    meta,
    blobs,
    search,
    deps,
    bus,
    notify,
    notifyRender,
    currentUser,
    actingUser,
    privateOwnerId,
    anonLocked,
    requireArtifact,
    authorize,
    limited,
    overStorage,
    billingGate,
    publishLimiter,
    sourceText,
  } = ctx
  const app = new OpenAPIHono<BlankEnv>()

  const Proposal = z
    .object({
      id: z.string(),
      state: z
        .enum(["open", "approved", "changes_requested", "withdrawn"])
        .describe("Review state: open, approved (went live), changes_requested, or withdrawn."),
      author: z.string().describe('Proposer\'s display name; "anonymous" if not signed in.'),
      on_behalf_of: z
        .object({ handle: z.string().nullable(), name: z.string().nullable() })
        .nullable()
        .optional()
        .describe(
          "When an agent proposed, the human it acted on behalf of; null for a direct human proposal.",
        ),
      message: z.string().nullable().describe("Proposer's cover message; null if none."),
      base_version: z.number().describe("Artifact version this proposal was authored against."),
      kind: z
        .enum(["file", "bundle"])
        .describe("Content shape: a single file or a multi-file bundle."),
      decided_by: z
        .string()
        .nullable()
        .describe("Who approved/requested-changes/withdrew it; null while still open."),
      decided_version: z
        .number()
        .nullable()
        .describe("The version it went live as when approved; null otherwise."),
      decision_note: z
        .string()
        .nullable()
        .describe("Reviewer's note on the decision; null while open or if none."),
      decided_at: z.string().nullable().describe("When it was decided; null while still open."),
      created_at: z.string(),
      preview_url: z
        .string()
        .describe("URL that renders the proposed content like a live version."),
      diff: z
        .object({ base_version: z.number(), ops: z.array(DiffOp) })
        .optional()
        .describe("Line diff vs the base version; present only on the single-proposal fetch."),
    })
    .openapi("Proposal")

  // The on-behalf-of humans for a SET of proposals, in ONE directory read, keyed by id.
  // This used to be a `getUsers([oneId])` awaited inside `proposalJson` — one ~80ms round
  // trip PER PROPOSAL on the list route, and the `Promise.all` around those does not overlap
  // them on this tier (see edge-pg.ts). The old comment reasoned "proposals-per-artifact are
  // few, so a per-proposal lookup is fine"; `listProposals` is unbounded, and on the edge
  // "few" is still 80ms each.
  type Byline = { handle: string | null; name: string | null }
  const bylinesFor = async (ps: ProposalRecord[]): Promise<Record<string, Byline>> => {
    const ids = [...new Set(ps.map((p) => p.on_behalf_of).filter((x): x is string => !!x))]
    if (ids.length === 0) return {}
    const out: Record<string, Byline> = {}
    for (const u of await meta.getUsers(ids)) out[u.id] = { handle: u.username, name: u.name }
    return out
  }

  const proposalJson = (a: ArtifactRecord, p: ProposalRecord, bylines: Record<string, Byline>) => ({
    id: p.id,
    state: p.state,
    author: p.author,
    // Delegation provenance: when an agent proposed, who it acted on behalf of (else null).
    on_behalf_of: p.on_behalf_of ? (bylines[p.on_behalf_of] ?? null) : null,
    message: p.message,
    base_version: p.base_version,
    kind: p.kind,
    decided_by: p.decided_by,
    decided_version: p.decided_version,
    decision_note: p.decision_note,
    decided_at: p.decided_at,
    created_at: p.created_at,
    // The proposed experience, rendered exactly like a live version.
    preview_url: `${deps.baseUrl}/raw/${a.short_id}/p/${p.id}/index.html`,
  })

  // Load an artifact + one of its proposals, read-gated. Returns an error
  // Response to short-circuit, or the pair to proceed.
  const loadProposal = async (
    c: Context,
  ): Promise<
    | { ok: false; error: Response }
    | { ok: true; artifact: ArtifactRecord; proposal: ProposalRecord }
  > => {
    const artifact = await meta.getByShortId(c.req.param("shortId") ?? "")
    if (!artifact || !(await authorize(c, "read", artifact)))
      return { ok: false, error: fail(c, 404, "not found") }
    // Proposals are in-review work, not public content: hidden from anonymous.
    if (await anonLocked(c, artifact)) return { ok: false, error: fail(c, 404, "not found") }
    const proposal = await meta.getProposal(c.req.param("proposalId") ?? "")
    if (!proposal || proposal.artifact_id !== artifact.id)
      return { ok: false, error: fail(c, 404, "not found") }
    return { ok: true, artifact, proposal }
  }

  // Propose a candidate version (commenter+). It does NOT go live; an editor
  // approves it. Same multipart shape as publish.
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/artifacts/{shortId}/proposals",
      tags: ["Proposals"],
      summary: "Propose a candidate version (multipart, like publish).",
      request: { params: z.object({ shortId: z.string() }) },
      responses: {
        201: {
          description: "The created proposal, plus the thread ids it marked addressed.",
          content: {
            "application/json": {
              schema: Proposal.extend({
                addressed: z
                  .array(z.string())
                  .describe("Thread ids this proposal flipped to addressed (pending review)."),
              }),
            },
          },
        },
      },
    }),
    async (c) => {
      const artifact = await meta.getByShortId(c.req.param("shortId"))
      if (!artifact || artifact.current_version === 0) return bail(fail(c, 404, "not found"))
      if (!(await authorize(c, "propose", artifact))) return bail(fail(c, 403, "forbidden"))
      // GitHub-synced artifacts are read-only in Derive; changes belong in the repo.
      if (await meta.isManagedArtifact(artifact.org_id, artifact.id))
        return bail(fail(c, 409, "managed by GitHub sync — propose this change in the repo"))
      const rl = await limited(c, publishLimiter)
      if (rl) return bail(rl)
      const len = Number(c.req.header("content-length") ?? 0)
      if (len > MAX_UPLOAD_BYTES) return bail(fail(c, 413, "upload too large"))

      const body = await c.req.parseBody()

      // `edits` — exact-match search/replace against the current stored source,
      // same contract and helper as a direct-publish `edits` revision (parity with
      // the MCP publish tool). Materializes full content, then flows into the same
      // propose() call as a `file` upload would.
      const editsField = body.edits
      let bytes: Uint8Array
      let filename: string
      let isBundle: boolean
      if (typeof editsField === "string") {
        let edits: AnyDocEdit[]
        try {
          edits = JSON.parse(editsField)
        } catch {
          return bail(fail(c, 400, "edits must be a JSON array of {old_str,new_str}"))
        }
        let materialized: MaterializedEdits
        try {
          const baseVersion = parseBaseVersion(str(body.base_version))
          materialized = await materializeEdits(
            { getVersion: meta.getVersion.bind(meta), sourceText },
            artifact,
            edits,
            baseVersion,
          )
        } catch (e) {
          if (e instanceof EditConflictError) return bail(fail(c, 409, e.message))
          return bail(
            fail(
              c,
              e instanceof EditError ? 400 : 500,
              e instanceof Error ? e.message : "edit failed",
            ),
          )
        }
        bytes = new TextEncoder().encode(materialized.content)
        if (bytes.length > MAX_UPLOAD_BYTES) return bail(fail(c, 413, "upload too large"))
        if (await overStorage(artifact.org_id, bytes.length))
          return bail(fail(c, 413, "storage quota exceeded"))
        filename = materialized.filename
        isBundle = false
      } else {
        const file = body.file
        if (!(file instanceof File)) return bail(fail(c, 400, "multipart field 'file' required"))
        bytes = new Uint8Array(await file.arrayBuffer())
        // content-length is advisory; re-check the actual buffered size (hard cap).
        if (bytes.length > MAX_UPLOAD_BYTES) return bail(fail(c, 413, "upload too large"))
        // Proposals store a blob immediately, so they count toward the storage cap
        // of the artifact's workspace.
        if (await overStorage(artifact.org_id, bytes.length))
          return bail(fail(c, 413, "storage quota exceeded"))
        filename = file.name
        isBundle =
          /\.zip$/i.test(file.name) ||
          body.kind === "bundle" ||
          (bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 3 || bytes[2] === 5))
      }

      const acting = await actingUser(c)
      const author = acting ? acting.name : str(body.author) || "anonymous"
      // Delegation provenance: when an AGENT proposes, record the human it acts on behalf of
      // (the granting/registering user). For a direct human proposal the acting id equals the
      // owner, so there's no delegation to record (stays null).
      const owner = await privateOwnerId(c)
      const onBehalfOfId = acting && owner && owner !== acting.id ? owner : null
      try {
        const { proposal } = await propose(meta, blobs, artifact.short_id, {
          bytes,
          filename,
          isBundle,
          spa: body.spa === "true" || body.spa === "1",
          message: str(body.message),
          author,
          author_id: acting?.id ?? null,
          on_behalf_of: onBehalfOfId,
        })
        bus.publish(artifact.id, { type: "proposal.created", proposal_id: proposal.id })
        // Threads this revision claims to fix flip to `addressed` (pending review),
        // tagged with the proposal id so approve/withdraw can release exactly these.
        const addressed = await markAddressed(
          meta,
          artifact.id,
          proposal.id,
          idList(str(body.addresses)),
        )
        for (const threadId of addressed)
          bus.publish(artifact.id, {
            type: "comment.addressed",
            thread_id: threadId,
            state: "addressed",
          })
        await notify(artifact, "proposal.created", {
          proposal_id: proposal.id,
          author: proposal.author,
          actor_id: proposal.author_id,
          message: proposal.message,
          base_version: proposal.base_version,
        })
        return c.json(
          { ...proposalJson(artifact, proposal, await bylinesFor([proposal])), addressed },
          201,
        )
      } catch (err) {
        if (err instanceof PublishError) return bail(fail(c, err.statusCode as 400, err.message))
        throw err
      }
    },
  )

  // List proposals (read-gated). ?state=open filters to the review queue.
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/artifacts/{shortId}/proposals",
      tags: ["Proposals"],
      summary: "List an artifact's proposals (optionally filtered by state).",
      request: {
        params: z.object({ shortId: z.string() }),
        query: z.object({
          state: z.enum(["open", "approved", "changes_requested", "withdrawn"]).optional(),
        }),
      },
      responses: {
        200: {
          description: "The artifact's proposals.",
          content: { "application/json": { schema: z.object({ proposals: z.array(Proposal) }) } },
        },
      },
    }),
    async (c) => {
      const artifact = await requireArtifact(c, "read")
      if (artifact instanceof Response) return bail(artifact)
      if (await anonLocked(c, artifact)) return bail(fail(c, 404, "not found"))
      // state is validated by the route's query contract (the enum above): an
      // out-of-enum ?state= is rejected with a 400 before we reach here, so consume
      // the typed value directly rather than re-coercing. Absent ⇒ undefined ⇒ all.
      const { state } = c.req.valid("query")
      const proposals = await meta.listProposals(artifact.id, state ? { state } : undefined)
      return c.json({
        proposals: ((bylines) => proposals.map((p) => proposalJson(artifact, p, bylines)))(
          await bylinesFor(proposals),
        ),
      })
    },
  )

  // One proposal, with a line diff of its content against its base version.
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/artifacts/{shortId}/proposals/{proposalId}",
      tags: ["Proposals"],
      summary: "One proposal, with a line diff against its base version.",
      request: { params: z.object({ shortId: z.string(), proposalId: z.string() }) },
      responses: {
        200: {
          description: "The proposal, with its diff.",
          content: { "application/json": { schema: Proposal } },
        },
      },
    }),
    async (c) => {
      const r = await loadProposal(c)
      if (!r.ok) return bail(r.error)
      const { artifact, proposal } = r
      const base = await meta.getVersion(artifact.id, proposal.base_version)
      const [a, b] = [base ? await sourceText(base) : "", await sourceText(proposal)]
      const ops = a !== null && b !== null ? diffLines(a, b) : []
      return c.json({
        ...proposalJson(artifact, proposal, await bylinesFor([proposal])),
        diff: { base_version: proposal.base_version, ops },
      })
    },
  )

  // Approve: the proposed content becomes the new current version (goes live).
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/artifacts/{shortId}/proposals/{proposalId}/approve",
      tags: ["Proposals"],
      summary: "Approve a proposal (its content goes live as a new version).",
      request: { params: z.object({ shortId: z.string(), proposalId: z.string() }) },
      responses: {
        200: {
          description: "The approved proposal + the version number it became.",
          content: {
            "application/json": {
              schema: Proposal.extend({
                published: z
                  .number()
                  .describe("The version number the approved proposal became live as."),
              }),
            },
          },
        },
      },
    }),
    async (c) => {
      const r = await loadProposal(c)
      if (!r.ok) return bail(r.error)
      const { artifact, proposal } = r
      if (!(await authorize(c, "approve", artifact))) return bail(fail(c, 403, "forbidden"))
      const blocked = await billingGate(c, artifact.org_id)
      if (blocked) return bail(blocked)
      if (proposal.state !== "open") return bail(fail(c, 409, `proposal is ${proposal.state}`))
      const me = await currentUser(c)
      const approver = me ? (me.name ?? me.username ?? me.email) : null
      const body = await readJson(c, z.object({ note: z.unknown().optional() }))
      if (body instanceof Response) return bail(body)
      try {
        const version = await approveProposalAction(
          { meta, blobs, bus, notify, notifyRender, search },
          artifact,
          proposal,
          approver,
          str(body.note) ?? null,
          me?.id ?? null,
        )
        const fresh = (await meta.getProposal(proposal.id)) as ProposalRecord
        return c.json({
          ...proposalJson(artifact, fresh, await bylinesFor([fresh])),
          published: version.n,
        })
      } catch (err) {
        if (err instanceof PublishError) return bail(fail(c, err.statusCode as 400, err.message))
        throw err
      }
    },
  )

  // Request changes: the candidate stays a proposal; the proposer can revise.
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/artifacts/{shortId}/proposals/{proposalId}/request-changes",
      tags: ["Proposals"],
      summary: "Request changes on a proposal (it stays open for revision).",
      request: { params: z.object({ shortId: z.string(), proposalId: z.string() }) },
      responses: {
        200: {
          description: "The proposal, now changes_requested.",
          content: { "application/json": { schema: Proposal } },
        },
      },
    }),
    async (c) => {
      const r = await loadProposal(c)
      if (!r.ok) return bail(r.error)
      const { artifact, proposal } = r
      if (!(await authorize(c, "approve", artifact))) return bail(fail(c, 403, "forbidden"))
      if (proposal.state !== "open") return bail(fail(c, 409, `proposal is ${proposal.state}`))
      const me = await currentUser(c)
      const reviewer = me ? (me.name ?? me.username ?? me.email) : null
      const body = await readJson(c, z.object({ note: z.unknown().optional() }))
      if (body instanceof Response) return bail(body)
      await requestChangesAction(
        { meta, blobs, bus, notify },
        artifact,
        proposal,
        reviewer,
        str(body.note) ?? null,
        me?.id ?? null,
      )
      const fresh = (await meta.getProposal(proposal.id)) as ProposalRecord
      return c.json(proposalJson(artifact, fresh, await bylinesFor([fresh])))
    },
  )

  // Withdraw: the proposer (or a manager) retracts an open proposal.
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/artifacts/{shortId}/proposals/{proposalId}/withdraw",
      tags: ["Proposals"],
      summary: "Withdraw an open proposal (proposer or a manager).",
      request: { params: z.object({ shortId: z.string(), proposalId: z.string() }) },
      responses: {
        200: {
          description: "The proposal, now withdrawn.",
          content: { "application/json": { schema: Proposal } },
        },
      },
    }),
    async (c) => {
      const r = await loadProposal(c)
      if (!r.ok) return bail(r.error)
      const { artifact, proposal } = r
      // Authorship keys on the stable proposer id, never the mutable display name.
      // Legacy rows (author_id null) fall back to the name match.
      const acting = await actingUser(c)
      const isAuthor =
        acting !== null &&
        (proposal.author_id ? proposal.author_id === acting.id : proposal.author === acting.name)
      if (!isAuthor && !(await authorize(c, "manage", artifact)))
        return bail(fail(c, 403, "forbidden"))
      if (proposal.state !== "open") return bail(fail(c, 409, `proposal is ${proposal.state}`))
      await meta.decideProposal(proposal.id, {
        state: "withdrawn",
        decided_by: acting?.name ?? null,
        decided_version: null,
      })
      // Retracting the proposal reopens the threads it had staged as addressed.
      for (const threadId of await releaseAddressed(meta, artifact.id, proposal.id, "open"))
        bus.publish(artifact.id, { type: "comment.addressed", thread_id: threadId, state: "open" })
      const fresh = (await meta.getProposal(proposal.id)) as ProposalRecord
      return c.json(proposalJson(artifact, fresh, await bylinesFor([fresh])))
    },
  )

  return app
}
