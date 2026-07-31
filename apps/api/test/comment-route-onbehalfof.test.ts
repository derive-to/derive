import { afterEach, describe, expect, it, vi } from "vitest"
import { as, jsonAs, makeAuthedApp, pub, type TestUser } from "./helpers"

// commentCreatedAction states a CONTRACT in its own docstring: a caller that authorized the
// request as a human principal must pass that principal as `onBehalfOf`, because an OAuth grant
// authors under the synthetic `oauth:<client>` id, which is a row in no table the collaborator
// check reads. Miss it and the author is untrusted, and the Slack and GitHub mirrors are skipped
// in silence — the comment lands in Derive and reaches no channel.
//
// The gate itself was already tested, by calling commentCreatedAction with onBehalfOf passed by
// hand. That proved the branch works and said nothing about whether the route supplies it. It
// did not, for as long as the route has existed, and the failure is invisible: no error, no log,
// just a mirror that never fires. So this asserts the call site, which is where the defect was.
const captured: { onBehalfOf?: string | null; actorId: string | null }[] = []
vi.mock("../src/lib/comment-actions", async (orig) => {
  const real = await orig<typeof import("../src/lib/comment-actions")>()
  return {
    ...real,
    commentCreatedAction: async (
      deps: Parameters<typeof real.commentCreatedAction>[0],
      artifact: Parameters<typeof real.commentCreatedAction>[1],
      comment: Parameters<typeof real.commentCreatedAction>[2],
      opts: Parameters<typeof real.commentCreatedAction>[3],
    ) => {
      captured.push({ onBehalfOf: opts.onBehalfOf, actorId: opts.actorId })
      return real.commentCreatedAction(deps, artifact, comment, opts)
    },
  }
})

const owner: TestUser = { id: "u-own", email: "own@x.com", name: "Owner", username: "own" }

afterEach(() => {
  captured.length = 0
})

describe("POST /v1/artifacts/:id/comments supplies onBehalfOf", () => {
  it("passes the request's human principal, not just the acting id", async () => {
    const { app } = makeAuthedApp("comment-obo", [owner], "editor")
    const r = await pub(app, "# Doc", { visibility: "org" }, undefined, as(owner.email))
    const shortId = (await r.json()).short_id as string

    const posted = await app.request(
      `/v1/artifacts/${shortId}/comments`,
      jsonAs(as(owner.email), { body_md: "a note" }),
    )
    expect(posted.status).toBe(201)
    expect(captured).toHaveLength(1)
    // Present at all — its absence is the whole defect. For a session caller it is the caller
    // themselves; for an OAuth grant it resolves to the grantor, which is the case that was
    // silently unmirrored.
    expect(captured[0]?.onBehalfOf).toBe(owner.id)
    expect(captured[0]?.actorId).toBe(owner.id)
  })
})
