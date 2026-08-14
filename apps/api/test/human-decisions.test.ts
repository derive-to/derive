import { describe, expect, it } from "vitest"
import { signApiToken } from "../src/lib/api-token"
import { as, bearer, jsonAs, makeAuthedApp, proposeAs, publishAs, type TestUser } from "./helpers"

/**
 * Approval is Derive's human trust boundary, not merely an editor-ranked write.
 * These requests deliberately use credentials that still have enough standing to
 * pass the ordinary `approve` capability check; the direct-human gate is the only
 * thing that should keep them from settling a decision.
 */
const seedProposal = async (name: string, encryptionKey?: string) => {
  const owner: TestUser = {
    id: `u_${name}_owner`,
    email: `${name}-owner@derive.test`,
    name: "Human owner",
  }
  const { app, meta } = makeAuthedApp(name, [owner], "editor", {
    deps: encryptionKey ? { encryptionKey } : undefined,
  })
  await app.request("/v1/me", { headers: as(owner.email) })
  const registered = await app.request(
    "/v1/agents",
    jsonAs(as(owner.email), { name: "Editor agent", role: "editor" }),
  )
  expect(registered.status).toBe(201)
  const agent = (await registered.json()) as { id: string; token: string }
  const published = await publishAs(
    app,
    "<h1>Human-approved base</h1>",
    { visibility: "org" },
    as(owner.email),
  )
  expect(published.status).toBe(201)
  const shortId = ((await published.json()) as { short_id: string }).short_id
  const proposed = await proposeAs(
    app,
    shortId,
    "<h1>Machine candidate</h1>",
    bearer(agent.token),
    { message: "Ready for a person's decision" },
  )
  expect(proposed.status).toBe(201)
  const proposalId = ((await proposed.json()) as { id: string }).id
  return { app, meta, owner, agent, shortId, proposalId }
}

describe("human decision boundary", () => {
  it("refuses proposal approval and request-changes from an editor agent", async () => {
    const { app, meta, owner, agent, shortId, proposalId } = await seedProposal("human-agent")
    for (const action of ["approve", "request-changes"]) {
      const response = await app.request(
        `/v1/artifacts/${shortId}/proposals/${proposalId}/${action}`,
        jsonAs(bearer(agent.token), {}),
      )
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({ error: "forbidden" })
    }

    const open = await app.request(`/v1/artifacts/${shortId}/proposals/${proposalId}`, {
      headers: as(owner.email),
    })
    expect((await open.json()).state).toBe("open")

    const humanApproval = await app.request(
      `/v1/artifacts/${shortId}/proposals/${proposalId}/approve`,
      jsonAs(as(owner.email), { note: "Human sign-off" }),
    )
    expect(humanApproval.status).toBe(200)
    expect((await meta.getProposal(proposalId))?.decided_by_id).toBe(owner.id)
  })

  it("refuses the static owner token and agent-bearer-plus-session ambiguity", async () => {
    const first = await seedProposal("human-static")
    const staticAttempt = await first.app.request(
      `/v1/artifacts/${first.shortId}/proposals/${first.proposalId}/approve`,
      jsonAs(bearer("tok"), {}),
    )
    expect(staticAttempt.status).toBe(403)

    const second = await seedProposal("human-mixed")
    const mixedAttempt = await second.app.request(
      `/v1/artifacts/${second.shortId}/proposals/${second.proposalId}/approve`,
      jsonAs({ ...as(second.owner.email), ...bearer(second.agent.token) }, {}),
    )
    expect(mixedAttempt.status).toBe(403)
  })

  it("refuses a short-lived minted API token even when it carries owner standing", async () => {
    const secret = "human-decision-signing-secret"
    const seeded = await seedProposal("human-minted", secret)
    const token = await signApiToken(
      secret,
      seeded.owner.id,
      "default",
      "owner",
      "derive-cli",
      Date.now() + 60_000,
    )
    const attempt = await seeded.app.request(
      `/v1/artifacts/${seeded.shortId}/proposals/${seeded.proposalId}/approve`,
      jsonAs(bearer(token), {}),
    )
    expect(attempt.status).toBe(403)
    expect((await seeded.meta.getProposal(seeded.proposalId))?.state).toBe("open")
  })

  it("refuses machine settlement of review rounds but admits the signed-in reviewer", async () => {
    const { app, meta, owner, agent, shortId } = await seedProposal("human-round")
    const artifact = await meta.getByShortId(shortId)
    if (!artifact) throw new Error("artifact was not created")
    const round = await meta.createReviewRound({
      id: "rr_human_boundary",
      artifact_id: artifact.id,
      version: artifact.current_version,
      requested_by: agent.id,
      requested_for: owner.id,
      note: null,
    })

    const agentAttempt = await app.request(
      `/v1/artifacts/${shortId}/review/approve`,
      jsonAs(bearer(agent.token), {}),
    )
    expect(agentAttempt.status).toBe(403)
    expect((await meta.listReviewRounds(artifact.id)).find((r) => r.id === round.id)?.state).toBe(
      "pending",
    )

    const humanAttempt = await app.request(
      `/v1/artifacts/${shortId}/review/approve`,
      jsonAs(as(owner.email), { note: "Approved by the requested person" }),
    )
    expect(humanAttempt.status).toBe(200)
    const decided = (await humanAttempt.json()).round
    expect(decided.state).toBe("approved")
    expect(decided.resolved_by_name).toBe("Human owner")
    expect((await meta.listReviewRounds(artifact.id))[0]?.resolved_by).toBe(owner.id)
  })
})
