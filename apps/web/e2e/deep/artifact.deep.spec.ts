import { Buffer } from "node:buffer"
import {
  activateThread,
  addComment,
  expect,
  openArtifact,
  publishArtifact,
  signUp,
  test,
} from "../fixtures"

// Deep coverage of the artifact page comment system: post, reply, react, edit,
// delete, resolve, reopen — plus insights, star/report, and tagging. Drives the
// real UI so it doubles as the regression net for the Artifact surface.

test.beforeEach(async ({ page }) => {
  await signUp(page)
  const shortId = await publishArtifact(
    page,
    "doc.md",
    "# Title\n\nThe body paragraph used by the artifact comment tests.",
  )
  await openArtifact(page, shortId)
})

test("comment, reply, resolve, and reopen a thread", async ({ page }) => {
  await addComment(page, "First observation.")

  // Activate the thread, reply, and see the reply land.
  await activateThread(page, "First observation.")
  await page.getByTestId("comment-reply-input").fill("A follow-up reply.")
  await page.getByTestId("comment-reply-send").click()
  await expect(page.getByText("A follow-up reply.")).toBeVisible()

  // Resolve: the thread collapses into the "Resolved (n)" section.
  await page.getByTestId("comment-resolve").click()
  await expect(page.getByText(/Resolved \(\d+\)/)).toBeVisible()

  // Expand that section, reopen the thread, and confirm the toggle flips back.
  await page.getByRole("button", { name: /Resolved \(\d+\)/ }).click()
  await activateThread(page, "First observation.")
  await page.getByTestId("comment-resolve").click() // currently reads "Reopen"
  await expect(page.getByTestId("comment-resolve")).toHaveText("Resolve")
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
  // Destructive actions confirm via the shared dialog, never immediately.
  await page.getByTestId("comment-delete-confirm").click()
  // A solo comment (no replies) is removed outright — no "Comment deleted" ghost left
  // pinned to the document. The tombstone path (when replies remain) is covered in the
  // API tests (comments.test.ts).
  await expect(page.getByText("Fixed now.")).toHaveCount(0)
  await expect(page.getByText("Comment deleted")).toHaveCount(0)
})

test("the insights panel opens and reports viewers", async ({ page }) => {
  // The owner opening their own artifact does not count as a viewer. Insights
  // lives in the "⋯ More" menu.
  await page.getByTestId("artifact-more").click()
  await page.getByTestId("artifact-insights").click()
  await expect(page.getByText(/viewers?/i).first()).toBeVisible()
})

test("star and report from the header", async ({ page }) => {
  // Star toggles favorite state optimistically.
  const star = page.getByTestId("artifact-star")
  await expect(star).toHaveAttribute("aria-pressed", "false")
  await star.click()
  await expect(star).toHaveAttribute("aria-pressed", "true")

  // Report lives in the ⋯ menu now; it opens a dialog, takes a reason, and confirms.
  await page.getByTestId("artifact-more").click()
  await page.getByTestId("artifact-report").click()
  await page.getByTestId("report-reason").fill("spam content")
  await page.getByTestId("report-submit").click()
  await expect(page.getByText(/flagged for review/i)).toBeVisible()
})

test("add a tag from the header", async ({ page }) => {
  // Tags moved into the ⋯ menu (opens a dialog) in the reimagined header.
  await page.getByTestId("artifact-more").click()
  await page.getByTestId("artifact-tags").click()
  await page.getByTestId("tag-new-input").fill("design")
  await page.getByTestId("tag-add").click()
  await expect(page.getByText("#design")).toBeVisible()
})

test("focus mode removes the shell entirely and restores it on exit", async ({ page }) => {
  const rail = page.locator('[data-slot="sidebar"]').first()
  await expect(rail).toBeVisible()

  // Enter via the ⋯ menu: the nav rail unmounts (fully gone, not the icon strip)
  // and the workbench header hides — the render is the whole viewport.
  await page.getByTestId("artifact-more").click()
  await page.getByTestId("artifact-focus").click()
  await expect(rail).toHaveCount(0)
  await expect(page.getByTestId("artifact-more")).not.toBeVisible()

  // Esc exits; the rail and header come back.
  await page.keyboard.press("Escape")
  await expect(page.locator('[data-slot="sidebar"]').first()).toBeVisible()
  await expect(page.getByTestId("artifact-more")).toBeVisible()
})

test("escape exits focus mode from inside the sandboxed render", async ({ page }) => {
  await page.getByTestId("artifact-more").click()
  await page.getByTestId("artifact-focus").click()
  await expect(page.locator('[data-slot="sidebar"]')).toHaveCount(0)

  // Clicking into the artifact moves keyboard focus INSIDE the iframe, out of the
  // host's window listeners' reach — the anchor client forwards Escape up.
  await page.frameLocator("iframe").locator("body").click()
  await page.keyboard.press("Escape")
  await expect(page.locator('[data-slot="sidebar"]').first()).toBeVisible()
})

test("typing c in the source editor never toggles the comments panel", async ({ page }) => {
  // The desktop panel starts open (its empty state shows on a fresh doc).
  const panelEmpty = page.getByText("Start the conversation.")
  await expect(panelEmpty).toBeVisible()

  // The source editor is contentEditable (CodeMirror) — the regression was a
  // mid-sentence "c" collapsing the panel out from under the typist.
  await page.getByTestId("artifact-more").click()
  await page.getByTestId("artifact-edit").click()
  await page.locator(".cm-content").click()
  await page.keyboard.type("once section c")
  await expect(panelEmpty).toBeVisible()
})

test("frame links: artifact links route in-app, everything else opens a new tab", async ({
  page,
}) => {
  // A target doc, plus an HTML doc linking to it by ABSOLUTE app URL (which the
  // server's relative-link resolver never marks) and to a non-artifact app page.
  const target = await publishArtifact(page, "target.md", "# Target doc")
  let linksId = ""
  await expect(async () => {
    const res = await page.request.post("/v1/artifacts", {
      multipart: {
        file: {
          name: "links.html",
          mimeType: "text/html",
          buffer: Buffer.from(
            `<a id="art" href="/artifacts/${target}">sibling</a><br><a id="ext" href="/login">elsewhere</a>`,
          ),
        },
        link_role: "viewer",
      },
    })
    expect(res.ok(), `publish failed: ${res.status()}`).toBeTruthy()
    linksId = ((await res.json()) as { short_id: string }).short_id
  }).toPass()
  await openArtifact(page, linksId)

  // The artifact link SPA-navigates the workbench — before, it navigated the
  // FRAME to the app origin, which refuses framing ("refused to connect").
  await page.frameLocator("iframe").locator("#art").click()
  await expect(page).toHaveURL(new RegExp(`/artifacts/.*${target}`))

  // Every other link opens a clean un-sandboxed tab; the frame never navigates.
  await openArtifact(page, linksId)
  const [popup] = await Promise.all([
    page.waitForEvent("popup"),
    page.frameLocator("iframe").locator("#ext").click(),
  ])
  expect(popup.url()).toContain("/login")
})
