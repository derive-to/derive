import { expect, publishArtifact, test } from "../fixtures"

// Templates are artifacts on a shelf. Quick Create lands on that shelf, and a tagged
// artifact is offered there with the two ways to start from it: a copy, or a handoff
// to the person's own agent. Neither opens source.
test("Quick Create lands on the shelf, where a tagged artifact offers a copy and an agent handoff", async ({
  owner,
}) => {
  const shortId = await publishArtifact(
    owner,
    "memo.md",
    "# Decision memo\n\nthe call",
    "text/markdown",
  )
  const tagged = await owner.request.put(`/v1/artifacts/${shortId}/tags`, {
    data: { tags: ["template"] },
  })
  expect(tagged.ok(), await tagged.text()).toBeTruthy()

  await owner.goto("/")
  await owner.getByTestId("library-new").click()
  await owner.getByTestId("library-new-template").click()
  await expect(owner).toHaveURL(/\/templates/)
  await expect(owner.getByTestId(`template-copy-${shortId}`)).toContainText("Make a copy")
  await owner.getByTestId(`template-ask-${shortId}`).click()
  await expect(owner.getByTestId("template-agent-brief")).toBeVisible()
  await expect(owner.getByTestId("artifact-source-editor")).toHaveCount(0)
})

test("a library pins an artifact starter and hands it to the agent", async ({ owner }) => {
  const source = await publishArtifact(
    owner,
    "trusted-decision.md",
    "# {{Decision owner}} decision\n\nAudience: {{Audience}}\n\nThis exact source is the reusable starting point.",
  )
  await owner.goto("/templates?tab=libraries")
  await owner.getByTestId("template-library-new").click()
  await owner.getByLabel("Name").fill("Product team starters")
  await owner.getByLabel("What belongs here?").fill("The documents our team trusts.")
  await owner.getByTestId("template-library-create").click()
  await expect(owner.getByTestId("template-library-detail")).toBeVisible()
  const libraryId = new URL(owner.url()).searchParams.get("library")
  if (!libraryId) throw new Error("created template library is missing its route id")
  await owner.getByRole("button", { name: "Library settings" }).click()
  await owner.getByTestId("template-library-visibility-public").click()
  await owner.getByRole("button", { name: "Save settings" }).click()
  await expect(owner.getByRole("link", { name: "Public page" })).toBeVisible()
  await owner.getByText("Add starter", { exact: true }).click()
  await expect(owner.getByTestId(`template-library-source-select-${source}`)).toBeVisible()
  await owner.getByTestId(`template-library-source-select-${source}`).click()
  await owner.getByRole("button", { name: "Continue" }).click()
  await owner.getByLabel("Starter name").fill("Trusted decision")
  await owner.getByLabel("Description").fill("A decision-ready starting point.")
  await owner.getByTestId("template-library-entry-create").click()
  await expect(owner.getByText("Trusted decision", { exact: true })).toBeVisible()
  await owner.getByRole("button", { name: "Use template" }).click()
  await expect(owner.getByRole("heading", { name: "Use Trusted decision" })).toBeVisible()
  await expect(owner.getByTestId("template-agent-brief")).toBeVisible()
  await expect(owner.getByTestId("artifact-source-editor")).toHaveCount(0)
  await owner.keyboard.press("Escape")
  await owner.goto("/templates?tab=libraries")
  await owner.getByTestId("template-library-scope-public").click()
  const libraryCard = owner.getByTestId(`template-library-card-${libraryId}`)
  await expect(libraryCard.getByText("E2E Tester", { exact: true })).toBeVisible()
  await owner.getByRole("link", { name: "Explore public libraries" }).click()
  await expect(owner).toHaveURL(/\/template-libraries/)
  await expect(
    owner.getByRole("heading", { name: "Useful beginnings, shared openly." }),
  ).toBeVisible()
  await owner.goto(`/template-libraries/${libraryId}`)
  await expect(owner.getByText("Published starter kit")).toBeVisible()
  await expect(owner.getByRole("link", { name: /View @/ })).toBeVisible()
  await expect(owner.getByRole("button", { name: "Copy library link" })).toBeVisible()

  const libraryResponse = await owner.request.get(`/v1/template-libraries/${libraryId}`)
  const publicLibrary = (await libraryResponse.json()) as { entries: Array<{ id: string }> }
  const entryId = publicLibrary.entries[0]?.id
  if (!entryId) throw new Error("published library is missing its starter")
  const browser = owner.context().browser()
  if (!browser) throw new Error("missing browser")
  const anonymousContext = await browser.newContext()
  const anonymous = await anonymousContext.newPage()
  await anonymous.goto(`/template-libraries/${libraryId}?use=${encodeURIComponent(entryId)}`)
  const expectedResume = `/template-libraries/${libraryId}?use=${encodeURIComponent(entryId)}`
  const frameHref = await anonymous.getByTestId("public-make-your-own").getAttribute("href")
  expect(new URL(frameHref ?? "", anonymous.url()).searchParams.get("return_to")).toBe(
    expectedResume,
  )
  await anonymous.getByTestId(`public-template-library-use-${entryId}`).click()
  expect(new URL(anonymous.url()).searchParams.get("return_to")).toBe(expectedResume)
  await anonymousContext.close()
})

test("a manager can retire a library without deleting its source artifact", async ({ owner }) => {
  const source = await publishArtifact(
    owner,
    "retired-starter.md",
    "# Retired starter\n\nThe source should remain after library retirement.",
  )
  await owner.goto("/templates?tab=libraries")
  await owner.getByTestId("template-library-new").click()
  await owner.getByLabel("Name").fill("Retired starters")
  await owner.getByTestId("template-library-create").click()
  await expect(owner.getByTestId("template-library-detail")).toBeVisible()
  await owner.getByRole("button", { name: "Library settings" }).click()
  await owner.getByRole("button", { name: "Delete library" }).click()
  await expect(owner.getByText("Delete Retired starters?")).toBeVisible()
  await owner.getByTestId("template-library-delete-confirm").click()
  await expect(owner).toHaveURL(/\/templates\?tab=libraries/)

  const response = await owner.request.get(`/v1/artifacts/${source}`)
  expect(response.ok()).toBeTruthy()
})
