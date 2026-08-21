import { describe, expect, it } from "vitest"
import { signApiToken } from "../src/lib/api-token"
import { as, bearer, jsonAs, makeAuthedApp, publishAs, type TestUser } from "./helpers"

/**
 * Settling a review round is Derive's human trust boundary, not merely an
 * editor-ranked write. These requests deliberately use credentials that still
 * carry enough standing to pass the ordinary capability check; the direct-human
 * gate is the only thing that should keep them from sending work back.
 */
const seedRound = async (name: string, encryptionKey?: string) => {
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
    "<h1>Reviewed base</h1>",
    { visibility: "org" },
    as(owner.email),
  )
  expect(published.status).toBe(201)
  const shortId = ((await published.json()) as { short_id: string }).short_id
  const artifact = await meta.getByShortId(shortId)
  if (!artifact) throw new Error("artifact was not created")
  const round = await meta.createReviewRound({
    id: `rr_${name}`,
    artifact_id: artifact.id,
    version: artifact.current_version,
    requested_by: agent.id,
    requested_for: owner.id,
    note: null,
  })
  return { app, meta, owner, agent, shortId, artifact, round }
}

const roundState = async (
  meta: Awaited<ReturnType<typeof seedRound>>["meta"],
  artifactId: string,
  roundId: string,
) => (await meta.listReviewRounds(artifactId)).find((r) => r.id === roundId)?.state

describe("human decision boundary", () => {
  it("refuses send-back from an editor agent's bearer token", async () => {
    const { app, meta, agent, shortId, artifact, round } = await seedRound("human-agent")
    const response = await app.request(
      `/v1/artifacts/${shortId}/review/send-back`,
      jsonAs(bearer(agent.token), {}),
    )
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: "a signed-in human must make this decision" })
    expect(await roundState(meta, artifact.id, round.id)).toBe("pending")
  })

  it("refuses the static owner token and agent-bearer-plus-session ambiguity", async () => {
    const first = await seedRound("human-static")
    const staticAttempt = await first.app.request(
      `/v1/artifacts/${first.shortId}/review/send-back`,
      jsonAs(bearer("tok"), {}),
    )
    expect(staticAttempt.status).toBe(403)

    const second = await seedRound("human-mixed")
    const mixedAttempt = await second.app.request(
      `/v1/artifacts/${second.shortId}/review/send-back`,
      jsonAs({ ...as(second.owner.email), ...bearer(second.agent.token) }, {}),
    )
    expect(mixedAttempt.status).toBe(403)
    expect(await roundState(second.meta, second.artifact.id, second.round.id)).toBe("pending")
  })

  it("refuses a short-lived minted API token even when it carries owner standing", async () => {
    const secret = "human-decision-signing-secret"
    const seeded = await seedRound("human-minted", secret)
    const token = await signApiToken(
      secret,
      seeded.owner.id,
      "default",
      "owner",
      "derive-cli",
      Date.now() + 60_000,
    )
    const attempt = await seeded.app.request(
      `/v1/artifacts/${seeded.shortId}/review/send-back`,
      jsonAs(bearer(token), {}),
    )
    expect(attempt.status).toBe(403)
    expect(await roundState(seeded.meta, seeded.artifact.id, seeded.round.id)).toBe("pending")
  })

  it("admits the signed-in reviewer, recording who settled the round and their note", async () => {
    const { app, meta, owner, shortId, artifact, round } = await seedRound("human-round")
    const humanAttempt = await app.request(
      `/v1/artifacts/${shortId}/review/send-back`,
      jsonAs(as(owner.email), { note: "Good to go — ship it" }),
    )
    expect(humanAttempt.status).toBe(200)
    const decided = (await humanAttempt.json()).round
    expect(decided.state).toBe("sent_back")
    expect(decided.note).toBe("Good to go — ship it")
    expect(decided.resolved_by_name).toBe("Human owner")
    const settled = (await meta.listReviewRounds(artifact.id)).find((r) => r.id === round.id)
    expect(settled?.resolved_by).toBe(owner.id)
  })
})
