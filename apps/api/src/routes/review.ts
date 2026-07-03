import { Hono } from "hono"
import { z } from "zod"
import type { AppContext } from "../context"
import { fail, readJson, str } from "../lib/http"

/** Review rounds: the human side of the /derive loop. An agent requests a review
 *  (on publish); the person answers in the doc and hits **Send back** (their
 *  answers ack), or **Approve** (the go-signal). The agent polls catch_up for the
 *  state. Approval is accepted from wherever — the sidebar button hits these
 *  routes; a terminal "go" records the same call. Humans never resolve threads. */
export const reviewRoutes = (ctx: AppContext) => {
  const { meta, bus, authorize, currentUser } = ctx
  const app = new Hono()

  // The round this caller should settle: their own pending round if they were the
  // one asked, else any pending round on the artifact (single-player: the one asker
  // is whoever is reviewing). Null when nothing is pending.
  const pendingFor = async (artifactId: string, meId: string | null) =>
    (meId ? await meta.getPendingRound(artifactId, meId) : null) ??
    (await meta.getPendingRound(artifactId))

  // Send back: "here are my answers." Flips the pending round to `sent_back` — the
  // signal the waiting agent polls for. Never gated on unanswered threads.
  app.post("/v1/artifacts/:shortId/review/send-back", async (c) => {
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact) return fail(c, 404, "not found")
    if (!(await authorize(c, "comment", artifact))) return fail(c, 403, "forbidden")
    const body = await readJson(c, z.object({ note: z.unknown().optional() }))
    if (body instanceof Response) return body
    const me = await currentUser(c)
    const round = await pendingFor(artifact.id, me?.id ?? null)
    if (!round) return fail(c, 409, "no review pending on this artifact")
    const updated = await meta.resolveReviewRound(round.id, {
      state: "sent_back",
      note: str(body.note) ?? null,
    })
    bus.publish(artifact.id, { type: "review.sent_back", round_id: round.id })
    return c.json({ round: updated })
  })

  // Approve: the go-signal. Flips the pending round to `approved`.
  app.post("/v1/artifacts/:shortId/review/approve", async (c) => {
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact) return fail(c, 404, "not found")
    if (!(await authorize(c, "approve", artifact))) return fail(c, 403, "forbidden")
    const body = await readJson(c, z.object({ note: z.unknown().optional() }))
    if (body instanceof Response) return body
    const me = await currentUser(c)
    const round = await pendingFor(artifact.id, me?.id ?? null)
    if (!round) return fail(c, 409, "no review pending on this artifact")
    const updated = await meta.resolveReviewRound(round.id, {
      state: "approved",
      note: str(body.note) ?? null,
    })
    bus.publish(artifact.id, { type: "review.approved", round_id: round.id })
    return c.json({ round: updated })
  })

  // The rounds on an artifact (newest first) + the current pending one, if any.
  // The web review card reads this to render "N questions · waiting".
  app.get("/v1/artifacts/:shortId/review", async (c) => {
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact) return fail(c, 404, "not found")
    if (!(await authorize(c, "read", artifact))) return fail(c, 404, "not found")
    const me = await currentUser(c)
    const [rounds, pending] = await Promise.all([
      meta.listReviewRounds(artifact.id),
      pendingFor(artifact.id, me?.id ?? null),
    ])
    return c.json({ rounds, pending: pending ?? null })
  })

  return app
}
