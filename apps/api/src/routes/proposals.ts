import {
  type ArtifactRecord,
  approveProposal,
  diffLines,
  type ProposalRecord,
  PublishError,
  propose,
} from "@derive/core"
import { type Context, Hono } from "hono"
import { z } from "zod"
import type { AppContext } from "../context"
import { markAddressed, releaseAddressed } from "../lib/addressed"
import { publishSweepEvents } from "../lib/anchor-sweep"
import { fail, MAX_UPLOAD_BYTES, readJson, str } from "../lib/http"

/** Parse a comma-separated id list (the `addresses` multipart field). */
const idList = (raw: string | undefined): string[] =>
  (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)

/** Reviews: a proposal is a candidate version awaiting approval. A commenter
 *  proposes; an editor approves (it goes live) or requests changes. */
export const proposalRoutes = (ctx: AppContext) => {
  const {
    meta,
    blobs,
    deps,
    bus,
    notify,
    notifyRender,
    currentUser,
    actingUser,
    anonLocked,
    requireArtifact,
    authorize,
    limited,
    overStorage,
    publishLimiter,
    sourceText,
  } = ctx
  const app = new Hono()

  const proposalJson = (a: ArtifactRecord, p: ProposalRecord) => ({
    id: p.id,
    state: p.state,
    author: p.author,
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
  const loadProposal = async (c: Context) => {
    const artifact = await meta.getByShortId(c.req.param("shortId") ?? "")
    if (!artifact || !(await authorize(c, "read", artifact)))
      return { error: fail(c, 404, "not found") as Response }
    // Proposals are in-review work, not public content: hidden from anonymous.
    if (await anonLocked(c, artifact)) return { error: fail(c, 404, "not found") as Response }
    const proposal = await meta.getProposal(c.req.param("proposalId") ?? "")
    if (!proposal || proposal.artifact_id !== artifact.id)
      return { error: fail(c, 404, "not found") as Response }
    return { artifact, proposal }
  }

  // Propose a candidate version (commenter+). It does NOT go live; an editor
  // approves it. Same multipart shape as publish.
  app.post("/v1/artifacts/:shortId/proposals", async (c) => {
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact || artifact.current_version === 0) return fail(c, 404, "not found")
    if (!(await authorize(c, "propose", artifact))) return fail(c, 403, "forbidden")
    // GitHub-synced artifacts are read-only in Derive; changes belong in the repo.
    if ((await meta.managedArtifactIds(artifact.org_id)).includes(artifact.id))
      return fail(c, 409, "managed by GitHub sync — propose this change in the repo")
    const rl = await limited(c, publishLimiter)
    if (rl) return rl
    const len = Number(c.req.header("content-length") ?? 0)
    if (len > MAX_UPLOAD_BYTES) return fail(c, 413, "upload too large")

    const body = await c.req.parseBody()
    const file = body.file
    if (!(file instanceof File)) return fail(c, 400, "multipart field 'file' required")
    const bytes = new Uint8Array(await file.arrayBuffer())
    // content-length is advisory; re-check the actual buffered size (hard cap).
    if (bytes.length > MAX_UPLOAD_BYTES) return fail(c, 413, "upload too large")
    // Proposals store a blob immediately, so they count toward the storage cap
    // of the artifact's workspace.
    if (await overStorage(artifact.org_id, bytes.length))
      return fail(c, 413, "storage quota exceeded")
    const isBundle =
      /\.zip$/i.test(file.name) ||
      body.kind === "bundle" ||
      (bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 3 || bytes[2] === 5))

    const acting = await actingUser(c)
    const author = acting ? acting.name : str(body.author) || "anonymous"
    try {
      const { proposal } = await propose(meta, blobs, artifact.short_id, {
        bytes,
        filename: file.name,
        isBundle,
        spa: body.spa === "true" || body.spa === "1",
        message: str(body.message),
        author,
        author_id: acting?.id ?? null,
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
        message: proposal.message,
        base_version: proposal.base_version,
      })
      return c.json({ ...proposalJson(artifact, proposal), addressed }, 201)
    } catch (err) {
      if (err instanceof PublishError) return fail(c, err.statusCode as 400, err.message)
      throw err
    }
  })

  // List proposals (read-gated). ?state=open filters to the review queue.
  app.get("/v1/artifacts/:shortId/proposals", async (c) => {
    const artifact = await requireArtifact(c, "read")
    if (artifact instanceof Response) return artifact
    if (await anonLocked(c, artifact)) return fail(c, 404, "not found")
    const stateQ = c.req.query("state")
    const state =
      stateQ === "open" ||
      stateQ === "approved" ||
      stateQ === "changes_requested" ||
      stateQ === "withdrawn"
        ? stateQ
        : undefined
    const proposals = await meta.listProposals(artifact.id, state ? { state } : undefined)
    return c.json({ proposals: proposals.map((p) => proposalJson(artifact, p)) })
  })

  // One proposal, with a line diff of its content against its base version.
  app.get("/v1/artifacts/:shortId/proposals/:proposalId", async (c) => {
    const r = await loadProposal(c)
    if ("error" in r) return r.error
    const { artifact, proposal } = r
    const base = await meta.getVersion(artifact.id, proposal.base_version)
    const [a, b] = [base ? await sourceText(base) : "", await sourceText(proposal)]
    const ops = a !== null && b !== null ? diffLines(a, b) : []
    return c.json({
      ...proposalJson(artifact, proposal),
      diff: { base_version: proposal.base_version, ops },
    })
  })

  // Approve: the proposed content becomes the new current version (goes live).
  app.post("/v1/artifacts/:shortId/proposals/:proposalId/approve", async (c) => {
    const r = await loadProposal(c)
    if ("error" in r) return r.error
    const { artifact, proposal } = r
    if (!(await authorize(c, "approve", artifact))) return fail(c, 403, "forbidden")
    if (proposal.state !== "open") return fail(c, 409, `proposal is ${proposal.state}`)
    const me = await currentUser(c)
    const approver = me ? (me.name ?? me.username ?? me.email) : null
    const body = await readJson(c, z.object({ note: z.unknown().optional() }))
    if (body instanceof Response) return body
    try {
      const version = await approveProposal(meta, blobs, proposal, approver, str(body.note) ?? null)
      bus.publish(artifact.id, {
        type: "proposal.approved",
        proposal_id: proposal.id,
        n: version.n,
      })
      bus.publish(artifact.id, {
        type: "version.published",
        n: version.n,
        message: version.message,
      })
      // The approved candidate is now live content — re-anchor existing threads
      // against it so feedback on changed text flips to `outdated`.
      await publishSweepEvents(meta, blobs, bus, artifact.id, version)
      // Threads this proposal addressed are now settled — the fix landed.
      for (const threadId of await releaseAddressed(meta, artifact.id, proposal.id, "resolved"))
        bus.publish(artifact.id, {
          type: "comment.addressed",
          thread_id: threadId,
          state: "resolved",
        })
      await notify(artifact, "proposal.approved", {
        proposal_id: proposal.id,
        version: version.n,
        approver,
      })
      notifyRender(artifact, version.n)
      const fresh = (await meta.getProposal(proposal.id)) as ProposalRecord
      return c.json({ ...proposalJson(artifact, fresh), published: version.n })
    } catch (err) {
      if (err instanceof PublishError) return fail(c, err.statusCode as 400, err.message)
      throw err
    }
  })

  // Request changes: the candidate stays a proposal; the proposer can revise.
  app.post("/v1/artifacts/:shortId/proposals/:proposalId/request-changes", async (c) => {
    const r = await loadProposal(c)
    if ("error" in r) return r.error
    const { artifact, proposal } = r
    if (!(await authorize(c, "approve", artifact))) return fail(c, 403, "forbidden")
    if (proposal.state !== "open") return fail(c, 409, `proposal is ${proposal.state}`)
    const me = await currentUser(c)
    const reviewer = me ? (me.name ?? me.username ?? me.email) : null
    const body = await readJson(c, z.object({ note: z.unknown().optional() }))
    if (body instanceof Response) return body
    await meta.decideProposal(proposal.id, {
      state: "changes_requested",
      decided_by: reviewer,
      decided_version: null,
      decision_note: str(body.note) ?? null,
    })
    bus.publish(artifact.id, { type: "proposal.changes_requested", proposal_id: proposal.id })
    // The fix didn't land — reopen the threads it had staged as addressed.
    for (const threadId of await releaseAddressed(meta, artifact.id, proposal.id, "open"))
      bus.publish(artifact.id, { type: "comment.addressed", thread_id: threadId, state: "open" })
    await notify(artifact, "proposal.changes_requested", { proposal_id: proposal.id, reviewer })
    const fresh = (await meta.getProposal(proposal.id)) as ProposalRecord
    return c.json(proposalJson(artifact, fresh))
  })

  // Withdraw: the proposer (or a manager) retracts an open proposal.
  app.post("/v1/artifacts/:shortId/proposals/:proposalId/withdraw", async (c) => {
    const r = await loadProposal(c)
    if ("error" in r) return r.error
    const { artifact, proposal } = r
    // Authorship keys on the stable proposer id, never the mutable display name.
    // Legacy rows (author_id null) fall back to the name match.
    const acting = await actingUser(c)
    const isAuthor =
      acting !== null &&
      (proposal.author_id ? proposal.author_id === acting.id : proposal.author === acting.name)
    if (!isAuthor && !(await authorize(c, "manage", artifact))) return fail(c, 403, "forbidden")
    if (proposal.state !== "open") return fail(c, 409, `proposal is ${proposal.state}`)
    await meta.decideProposal(proposal.id, {
      state: "withdrawn",
      decided_by: acting?.name ?? null,
      decided_version: null,
    })
    // Retracting the proposal reopens the threads it had staged as addressed.
    for (const threadId of await releaseAddressed(meta, artifact.id, proposal.id, "open"))
      bus.publish(artifact.id, { type: "comment.addressed", thread_id: threadId, state: "open" })
    const fresh = (await meta.getProposal(proposal.id)) as ProposalRecord
    return c.json(proposalJson(artifact, fresh))
  })

  return app
}
