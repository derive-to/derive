import { addComment, expect, openArtifact, publishArtifact, test } from "../fixtures"

// Clicking the artifact itself should dismiss an open popover. The artifact renders
// in a sandboxed <iframe>, which swallows the click — the parent document never
// sees a pointerdown — so Radix's normal outside-dismiss never fires. The fix wires
// it through the window `blur` that an iframe focus-steal produces (IframeBlurClose in
// the shared PopoverContent); this guards it via the comment reaction popover.
test("clicking the artifact iframe dismisses an open popover", async ({ owner }) => {
  const id = await publishArtifact(owner, "doc.md", "# Doc\n\nbody text")
  await openArtifact(owner, id)

  // A comment gives us a row with the shared reaction Popover. Open it.
  await addComment(owner, "a comment to react to")
  await owner.getByTestId("comment-react").click()
  await expect(owner.getByTestId("react-emoji-👍")).toBeVisible()

  // Click into the artifact (focuses the iframe → window blur → dismiss).
  await owner.locator("iframe").first().click()
  await expect(owner.getByTestId("react-emoji-👍")).toBeHidden()
})
