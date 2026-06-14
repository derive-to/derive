import { expect, openArtifact, publishArtifact, test } from "../fixtures"

// Clicking the artifact itself should dismiss an open popover. The artifact renders
// in a sandboxed <iframe>, which swallows the click — the parent document never
// sees a pointerdown — so Radix's normal outside-dismiss never fires. The fix wires
// it through the window `blur` that an iframe focus-steal produces; this guards it.
test("clicking the artifact iframe dismisses an open popover", async ({ owner }) => {
  const id = await publishArtifact(owner, "doc.md", "# Doc\n\nbody text")
  await openArtifact(owner, id)

  // Open the cursor popover; its contents (the kind picker) are visible.
  await owner.getByTestId("cursor-self-trigger").click()
  await expect(owner.getByTestId("cursor-kind-emoji")).toBeVisible()

  // Click into the artifact (focuses the iframe → window blur → dismiss).
  await owner.locator("iframe").first().click()
  await expect(owner.getByTestId("cursor-kind-emoji")).toBeHidden()
})
