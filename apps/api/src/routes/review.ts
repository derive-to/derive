import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { BlankEnv } from "hono/types"
import type { AppContext } from "../context"
import { bail, fail, readJson, str } from "../lib/http"

/** Review rounds: the human side of the /derive loop. An agent requests a review
 *  (on publish); the person answers in the doc and hits **Send back** (their
 *  answers ack), or **Approve** (the go-signal). The agent polls catch_up for the
 *  state. Approval is accepted from wherever — the sidebar button hits these
 *  routes; a terminal "go" records the same call. Humans never resolve threads.
 *  The ReviewRound response schema is the single source for the web client's type. */
export const reviewRoutes = (ctx: AppContext) => {
  const { meta, bus, notify, currentUser, requireArtifact, requireDirectHuman, billingGate } = ctx
  const app = new OpenAPIHono<BlankEnv>()

  const ReviewRound = z
    .object({
      id: z.string(),
      artifact_id: z.string(),
      version: z.number().describe("The artifact version this round is reviewing."),
      requested_by: z
        .string()
        .describe("Who asked for the review (usually the agent that published)."),
      requested_for: z.string().describe("The person asked to answer or approve this round."),
      state: z
        .enum(["pending", "sent_back", "approved"])
        .describe(
          "Round state: pending, sent_back (answers returned), or approved (the go-signal).",
        ),
      note: z.string().nullable().describe("Free-text note attached to the round; null if none."),
      resolved_by_name: z
        .string()
        .nullable()
        .describe("The human who settled the round; null while pending or for legacy history."),
      created_at: z.string(),
      resolved_at: z
        .string()
        .nullable()
        .describe("When it was sent back or approved; null while pending."),
    })
    .openapi("ReviewRound")

  // The round this caller should settle: their own pending round if they were the
  // one asked, else any pending round on the artifact (single-player: the one asker
  // is whoever is reviewing). Null when nothing is pending.
  const pendingFor = async (artifactId: string, meId: string | null) =>
    (meId ? await meta.getPendingRound(artifactId, meId) : null) ??
    (await meta.getPendingRound(artifactId))

  // Send back: "here are my answers." Flips the pending round to `sent_back` — the
  // signal the waiting agent polls for. Never gated on unanswered threads.
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/artifacts/{shortId}/review/send-back",
      tags: ["Review"],
      summary: "Send back a review with the human's answers.",
      request: {
        params: z.object({ shortId: z.string() }),
        body: {
          required: false,
          content: {
            "application/json": {
              schema: z.object({
                note: z
                  .string()
                  .max(10_000)
                  .optional()
                  .describe(
                    "The human's note to the agent — answers, asks, or the go-signal (\"good to go\"). Carried on the round and surfaced in the agent's catch_up.",
                  ),
              }),
            },
          },
        },
      },
      responses: {
        200: {
          description: "The round, now sent_back.",
          content: { "application/json": { schema: z.object({ round: ReviewRound }) } },
        },
      },
    }),
    async (c) => {
      const artifact = await requireArtifact(c, "comment", { split: true })
      if (artifact instanceof Response) return bail(artifact)
      const human = await requireDirectHuman(c)
      if (human instanceof Response) return bail(human)
      const body = await readJson(c, z.object({ note: z.unknown().optional() }))
      if (body instanceof Response) return bail(body)
      const round = await pendingFor(artifact.id, human.id)
      if (!round) return bail(fail(c, 409, "no review pending on this artifact"))
      const updated = await meta.resolveReviewRound(round.id, {
        state: "sent_back",
        // Bounded to the declared cap however the body arrived — the note is interpolated
        // into the agent's catch_up prompt, and an unbounded field there is a cost hole.
        note: str(body.note)?.slice(0, 10_000) ?? null,
        resolved_by: human.id,
        resolved_by_name: human.name,
      })
      if (!updated) return bail(fail(c, 409, "no review pending on this artifact"))
      bus.publish(artifact.id, { type: "review.sent_back", round_id: round.id })
      // Fan out like every other lifecycle event. These two settled the round only on the bus
      // before, so a webhook subscriber — and, now that channels can subscribe, a team — never
      // learned the doc had stopped waiting.
      await notify(artifact, "review.sent_back", {
        author: human.name,
        actor_id: human.id,
      })
      return c.json({ round: updated })
    },
  )

  // Approve: the go-signal. Flips the pending round to `approved`.
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/artifacts/{shortId}/review/approve",
      tags: ["Review"],
      summary: "Approve a review (the go-signal).",
      request: { params: z.object({ shortId: z.string() }) },
      responses: {
        200: {
          description: "The round, now approved.",
          content: { "application/json": { schema: z.object({ round: ReviewRound }) } },
        },
      },
    }),
    async (c) => {
      const artifact = await requireArtifact(c, "approve", { split: true })
      if (artifact instanceof Response) return bail(artifact)
      const human = await requireDirectHuman(c)
      if (human instanceof Response) return bail(human)
      const blocked = await billingGate(c, artifact.org_id)
      if (blocked) return bail(blocked)
      const body = await readJson(c, z.object({ note: z.unknown().optional() }))
      if (body instanceof Response) return bail(body)
      const round = await pendingFor(artifact.id, human.id)
      if (!round) return bail(fail(c, 409, "no review pending on this artifact"))
      const updated = await meta.resolveReviewRound(round.id, {
        state: "approved",
        note: str(body.note) ?? null,
        resolved_by: human.id,
        resolved_by_name: human.name,
      })
      if (!updated) return bail(fail(c, 409, "no review pending on this artifact"))
      bus.publish(artifact.id, { type: "review.approved", round_id: round.id })
      await notify(artifact, "review.approved", {
        author: human.name,
        actor_id: human.id,
      })
      return c.json({ round: updated })
    },
  )

  // The rounds on an artifact (newest first) + the current pending one, if any.
  // The web review card reads this to render "N questions · waiting".
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/artifacts/{shortId}/review",
      tags: ["Review"],
      summary: "List an artifact's review rounds and the pending one, if any.",
      request: { params: z.object({ shortId: z.string() }) },
      responses: {
        200: {
          description: "All rounds (newest first) and the current pending round or null.",
          content: {
            "application/json": {
              schema: z.object({
                rounds: z.array(ReviewRound).describe("All review rounds, newest first."),
                pending: ReviewRound.nullable().describe(
                  "The current unsettled round, or null if none is pending.",
                ),
              }),
            },
          },
        },
      },
    }),
    async (c) => {
      const artifact = await requireArtifact(c, "read")
      if (artifact instanceof Response) return bail(artifact)
      const me = await currentUser(c)
      const [rounds, pending] = await Promise.all([
        meta.listReviewRounds(artifact.id),
        pendingFor(artifact.id, me?.id ?? null),
      ])
      return c.json({ rounds, pending: pending ?? null })
    },
  )

  return app
}
