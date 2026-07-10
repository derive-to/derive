import { expect, openArtifact, publishArtifact, shareArtifact, test } from "../fixtures"

const NOTE = "A collaborator comment during your outage"

// Real-time robustness: a dropped live stream must READ as "reconnecting" — not a silently
// frozen collaborative view — and on reconnect the stream re-establishes, the updates missed
// during the gap resync in, and the cue clears. Driven with a real network drop (setOffline)
// and a second collaborator posting while we're down.
test("SSE drop shows a reconnecting cue, then resyncs the gap and clears", async ({
  owner,
  secondUser,
}) => {
  test.setTimeout(90_000)
  const id = await publishArtifact(owner)
  await shareArtifact(owner.request, id, secondUser.email, "commenter")
  await openArtifact(owner, id)

  // Drop the live stream — the cue appears (offline is the fast, reliable signal).
  await owner.context().setOffline(true)
  await expect(owner.getByTestId("live-reconnecting")).toBeVisible()

  // A collaborator comments while we're disconnected — we do NOT see it live.
  await secondUser.page.request.post(`/v1/artifacts/${id}/comments`, { data: { body_md: NOTE } })
  await owner.waitForTimeout(1000)
  await expect(owner.getByText(NOTE)).toHaveCount(0)

  // Back online: the stream re-establishes, resync pulls in the missed comment, the cue clears.
  await owner.context().setOffline(false)
  await expect(owner.getByText(NOTE)).toBeVisible({ timeout: 15_000 })
  await expect(owner.getByTestId("live-reconnecting")).toBeHidden({ timeout: 15_000 })
})
