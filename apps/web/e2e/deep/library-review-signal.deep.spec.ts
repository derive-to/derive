import { expect, proposeEdit, publishArtifact, shareArtifact, test } from "../fixtures"

// The library card surfaces an artifact's review queue: open proposals show as a count
// in the activity row, inked when they're yours to decide. This drives the whole chain —
// the list endpoint's `open_proposals` enrichment and the ProposalSignal render — so a
// card that silently dropped the review loop can't ship. Setup mirrors review.deep: the
// owner owns, a shared editor authors the proposals (owner ≠ author, so owner can decide).
test("library card badges open proposals, featured when they're yours to review", async ({
  owner,
  secondUser,
}) => {
  const id = await publishArtifact(owner)
  await shareArtifact(owner.request, id, secondUser.email, "editor")
  await proposeEdit(secondUser.page.request, id, "Tighten the intro", "# Doc\n\ntighter intro")
  await proposeEdit(secondUser.page.request, id, "Fix the footer", "# Doc\n\nbody\n\nfixed footer")

  await owner.goto("/")
  await expect(owner.getByTestId(`artifact-card-open-${id}`)).toBeVisible()

  // The review signal reads the two open proposals, featured because the owner can act
  // on them (the sanctioned "needs you" ink, same grammar as an @mention).
  const signal = owner.getByTestId("proposal-signal")
  await expect(signal).toBeVisible()
  await expect(signal).toHaveText("2")
  await expect(signal).toHaveAttribute("data-featured", "awaiting")
})
