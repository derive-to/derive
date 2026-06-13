import {
  type ArtifactRecord,
  approveProposal,
  diffLines,
  type ProposalRecord,
  PublishError,
  propose,
} from "@dock/core"
import { type Context, Hono } from "hono"
import type { AppContext } from "../context"
import { MAX_UPLOAD_BYTES, str } from "../lib/http"

/** Reviews: a proposal is a candidate version awaiting approval. A commenter
 *  proposes; an editor approves (it goes live) or requests changes. */
export const proposalRoutes = (ctx: AppContext) => {
  const {
    meta,
    blobs,
    deps,
    bus,
    notify,
    currentUser,
    actingUser,
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
      return { error: c.json({ error: "not found" }, 404) as Response }
    const proposal = await meta.getProposal(c.req.param("proposalId") ?? "")
    if (!proposal || proposal.artifact_id !== artifact.id)
      return { error: c.json({ error: "not found" }, 404) as Response }
    return { artifact, proposal }
  }

  // Propose a candidate version (commenter+). It does NOT go live; an editor
  // approves it. Same multipart shape as publish.
  app.post("/v1/artifacts/:shortId/proposals", async (c) => {
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact || artifact.current_version === 0) return c.json({ error: "not found" }, 404)
    if (!(await authorize(c, "propose", artifact))) return c.json({ error: "forbidden" }, 403)
    const rl = await limited(c, publishLimiter)
    if (rl) return rl
    const len = Number(c.req.header("content-length") ?? 0)
    if (len > MAX_UPLOAD_BYTES) return c.json({ error: "upload too large" }, 413)

    const body = await c.req.parseBody()
    const file = body.file
    if (!(file instanceof File)) return c.json({ error: "multipart field 'file' required" }, 400)
    const bytes = new Uint8Array(await file.arrayBuffer())
    // Proposals store a blob immediately, so they count toward the storage cap
    // of the artifact's workspace.
    if (await overStorage(artifact.org_id, bytes.length))
      return c.json({ error: "storage quota exceeded" }, 413)
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
      })
      bus.publish(artifact.id, { type: "proposal.created", proposal_id: proposal.id })
      await notify(artifact, "proposal.created", {
        proposal_id: proposal.id,
        author: proposal.author,
        message: proposal.message,
        base_version: proposal.base_version,
      })
      return c.json(proposalJson(artifact, proposal), 201)
    } catch (err) {
      if (err instanceof PublishError) return c.json({ error: err.message }, err.statusCode as 400)
      throw err
    }
  })

  // List proposals (read-gated). ?state=open filters to the review queue.
  app.get("/v1/artifacts/:shortId/proposals", async (c) => {
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact || !(await authorize(c, "read", artifact)))
      return c.json({ error: "not found" }, 404)
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
    if (!(await authorize(c, "approve", artifact))) return c.json({ error: "forbidden" }, 403)
    if (proposal.state !== "open") return c.json({ error: `proposal is ${proposal.state}` }, 409)
    const me = await currentUser(c)
    const approver = me ? (me.name ?? me.email) : null
    const body = (await c.req.json().catch(() => ({}))) as { note?: unknown }
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
      await notify(artifact, "proposal.approved", {
        proposal_id: proposal.id,
        version: version.n,
        approver,
      })
      const fresh = (await meta.getProposal(proposal.id)) as ProposalRecord
      return c.json({ ...proposalJson(artifact, fresh), published: version.n })
    } catch (err) {
      if (err instanceof PublishError) return c.json({ error: err.message }, err.statusCode as 400)
      throw err
    }
  })

  // Request changes: the candidate stays a proposal; the proposer can revise.
  app.post("/v1/artifacts/:shortId/proposals/:proposalId/request-changes", async (c) => {
    const r = await loadProposal(c)
    if ("error" in r) return r.error
    const { artifact, proposal } = r
    if (!(await authorize(c, "approve", artifact))) return c.json({ error: "forbidden" }, 403)
    if (proposal.state !== "open") return c.json({ error: `proposal is ${proposal.state}` }, 409)
    const me = await currentUser(c)
    const reviewer = me ? (me.name ?? me.email) : null
    const body = (await c.req.json().catch(() => ({}))) as { note?: unknown }
    await meta.decideProposal(proposal.id, {
      state: "changes_requested",
      decided_by: reviewer,
      decided_version: null,
      decision_note: str(body.note) ?? null,
    })
    bus.publish(artifact.id, { type: "proposal.changes_requested", proposal_id: proposal.id })
    await notify(artifact, "proposal.changes_requested", { proposal_id: proposal.id, reviewer })
    const fresh = (await meta.getProposal(proposal.id)) as ProposalRecord
    return c.json(proposalJson(artifact, fresh))
  })

  // Withdraw: the proposer (or a manager) retracts an open proposal.
  app.post("/v1/artifacts/:shortId/proposals/:proposalId/withdraw", async (c) => {
    const r = await loadProposal(c)
    if ("error" in r) return r.error
    const { artifact, proposal } = r
    const me = await currentUser(c)
    const who = me ? (me.name ?? me.email) : null
    const isAuthor = who !== null && who === proposal.author
    if (!isAuthor && !(await authorize(c, "manage", artifact)))
      return c.json({ error: "forbidden" }, 403)
    if (proposal.state !== "open") return c.json({ error: `proposal is ${proposal.state}` }, 409)
    await meta.decideProposal(proposal.id, {
      state: "withdrawn",
      decided_by: who,
      decided_version: null,
    })
    const fresh = (await meta.getProposal(proposal.id)) as ProposalRecord
    return c.json(proposalJson(artifact, fresh))
  })

  return app
}
