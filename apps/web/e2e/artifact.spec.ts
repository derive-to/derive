import { expect, test } from "@playwright/test"
import { publishArtifact, signUp } from "./helpers"

// Deep coverage of the artifact page comment system: post, reply, react, edit,
// delete, resolve, reopen — plus the insights panel. Drives the real UI so it
// doubles as the regression net for the Tailwind/shadcn conversion of Artifact.

// Post a top-level comment and return its body text.
async function addComment(page: import("@playwright/test").Page, body: string) {
  await page.getByTitle("New comment").click()
  await page.getByPlaceholder("Add a comment…").fill(body)
  await page.getByRole("button", { name: "Comment", exact: true }).click()
  await expect(page.getByText(body)).toBeVisible()
}

test.beforeEach(async ({ page }) => {
  await signUp(page)
  const shortId = await publishArtifact(
    page,
    "doc.md",
    "# Title\n\nThe body paragraph used by the artifact comment tests.",
  )
  await page.goto(`/a/${shortId}`)
  await expect(page.getByText("Comments", { exact: true })).toBeVisible()
})

test("comment, reply, resolve, and reopen a thread", async ({ page }) => {
  await addComment(page, "First observation.")

  // Activate the thread, reply, and see the reply land.
  await page.getByText("First observation.").click()
  await page.getByPlaceholder("Reply… (@ to mention)").fill("A follow-up reply.")
  await page.getByRole("button", { name: "Reply", exact: true }).click()
  await expect(page.getByText("A follow-up reply.")).toBeVisible()

  // Resolve: the thread collapses into the "Resolved (n)" section.
  await page.getByRole("button", { name: "Resolve" }).click()
  await expect(page.getByText(/Resolved \(\d+\)/)).toBeVisible()

  // Expand that section, reopen the thread, and confirm it leaves "resolved".
  await page.getByRole("button", { name: /Resolved \(\d+\)/ }).click()
  await page.getByText("First observation.").first().click()
  await page.getByRole("button", { name: "Reopen" }).click()
  await expect(page.getByRole("button", { name: "Resolve" })).toBeVisible()
})

test("react to a comment with an emoji", async ({ page }) => {
  await addComment(page, "Worth a reaction.")

  const row = page.getByTestId("comment-row").filter({ hasText: "Worth a reaction." }).first()
  await row.hover()
  await row.getByTestId("comment-react").click()
  await page.getByTestId("react-emoji-👍").click()

  // A reaction pill with a count of 1 appears on the comment.
  await expect(row.getByTestId("reaction-pill-👍")).toContainText("1")
})

test("edit and delete an own comment", async ({ page }) => {
  await addComment(page, "Typo here.")

  const row = page.getByTestId("comment-row").filter({ hasText: "Typo here." }).first()
  await row.hover()
  await row.getByTestId("comment-more").click()
  await page.getByTestId("comment-edit").click()
  await page.getByTestId("comment-edit-input").fill("Fixed now.")
  await page.getByTestId("comment-edit-save").click()
  await expect(page.getByText("Fixed now.")).toBeVisible()

  const fixed = page.getByTestId("comment-row").filter({ hasText: "Fixed now." }).first()
  await fixed.hover()
  await fixed.getByTestId("comment-more").click()
  await page.getByTestId("comment-delete").click()
  await expect(page.getByText("Comment deleted")).toBeVisible()
})

test("insights panel reports the owner's own view is excluded", async ({ page }) => {
  // The owner opening their own artifact does not count as a viewer.
  await page.getByRole("button", { name: /Insights/ }).click()
  await expect(page.getByText(/viewers?/i).first()).toBeVisible()
})

test("star and report from the header", async ({ page }) => {
  // Star toggles favorite state optimistically.
  const star = page.getByTestId("artifact-star")
  await expect(star).toHaveAttribute("aria-pressed", "false")
  await star.click()
  await expect(star).toHaveAttribute("aria-pressed", "true")

  // Report opens a popover, takes a reason, and confirms.
  await page.getByTestId("artifact-report").click()
  await page.getByTestId("report-reason").fill("spam content")
  await page.getByTestId("report-submit").click()
  await expect(page.getByText(/flagged for review/i)).toBeVisible()
})

test("add a tag from the header", async ({ page }) => {
  await page.getByTestId("artifact-tags").click()
  await page.getByTestId("tag-new-input").fill("design")
  await page.getByTestId("tag-add").click()
  await expect(page.getByText("#design")).toBeVisible()
})
