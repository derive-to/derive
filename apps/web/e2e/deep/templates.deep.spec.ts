import { expect, publishArtifact, shareArtifact, test } from "../fixtures"

// Templates must be a complete creation route, not merely a catalog screen. This
// covers the two distinct output contracts: ordinary shareable artifacts and
// portable Context manifests that bind authority only after publication.
test("Quick Create uses a Template to publish an ordinary artifact that can be shared", async ({
  owner,
  secondUser,
}) => {
  await owner.goto("/")
  await owner.getByTestId("library-quick-decision-memo").click()
  await expect(owner).toHaveURL(/\/new\?template=decision-memo/)
  await expect(owner.getByText("Starting from Decision memo")).toBeVisible()
  await expect(owner.getByTestId("artifact-source-editor")).toContainText("Decision")

  await owner.getByTestId("artifact-title-input").fill("Shareable template memo")
  await owner.getByTestId("artifact-publish-version").click()
  await expect(owner).toHaveURL(/\/artifacts\//, { timeout: 15_000 })

  const ref = new URL(owner.url()).pathname.split("/").at(-1)
  const shortId = ref?.split("@", 1)[0]?.split("-").at(-1)
  if (!shortId) throw new Error("published Template artifact has no route ref")
  await shareArtifact(owner.request, shortId, secondUser.email, "viewer")
  await secondUser.page.goto(`/artifacts/${shortId}`)
  await expect(secondUser.page.getByText("Shareable template memo")).toBeVisible()
})

test("a Context Template publishes a safe manifest before binding an agent", async ({ owner }) => {
  const agent = await owner.request.post("/v1/agents", { data: { name: "Template agent" } })
  expect(agent.ok()).toBeTruthy()

  await owner.goto("/templates?tab=contexts")
  await owner.getByTestId("template-card-weekly-research-context").click()
  await owner.getByTestId("template-use").click()
  await expect(owner).toHaveURL(/\/new\?template=weekly-research-context/)
  await expect(owner.getByText("Starting from Weekly research brief")).toBeVisible()
  await expect(owner.getByTestId("artifact-source-editor")).toContainText(
    "Bind a runner, sources, permissions, and credentials separately",
  )

  await owner.getByTestId("artifact-publish-version").click()
  await expect(owner).toHaveURL(/\/contexts\?manifest=/, { timeout: 15_000 })
  await expect(owner.getByTestId("context-create-manifest")).not.toHaveValue("")
  await expect(owner.getByText("Connections and secrets are not stored in it.")).toBeVisible()
  await owner.getByTestId("context-create-submit").click()
  await expect(owner.getByTestId("context-card")).toHaveCount(1)
})

test("a library pins an artifact starter and opens an independent draft", async ({ owner }) => {
  const source = await publishArtifact(
    owner,
    "trusted-decision.md",
    "# Trusted decision\n\nThis exact source is the reusable starting point.",
  )
  await owner.goto("/templates?tab=libraries")
  await owner.getByTestId("template-library-new").click()
  await owner.getByLabel("Name").fill("Product team starters")
  await owner.getByLabel("What belongs here?").fill("The documents our team trusts.")
  await owner.getByTestId("template-library-create").click()
  await expect(owner.getByTestId("template-library-detail")).toBeVisible()
  await owner.getByRole("button", { name: "Library settings" }).click()
  await owner.getByRole("button", { name: /Public Discoverable by anyone and MCP/ }).click()
  await owner.getByRole("button", { name: "Save settings" }).click()
  await expect(owner.getByRole("link", { name: "Public page" })).toBeVisible()
  await owner.getByText("Add starter", { exact: true }).click()
  await owner.getByLabel("Source artifact ID or Derive link").fill(`trusted-decision-${source}`)
  await owner.getByLabel("Display name").fill("Trusted decision")
  await owner.getByLabel("Description").fill("A decision-ready starting point.")
  await owner
    .getByLabel(/Inputs/)
    .fill("*Decision owner — makes the call\nAudience — needs the record")
  await owner.getByTestId("template-library-entry-create").click()
  await expect(owner.getByText("Trusted decision", { exact: true })).toBeVisible()
  await expect(owner.getByText(/Needs: Decision owner · required · Audience/)).toBeVisible()
  await owner.getByRole("button", { name: "Use starter" }).click()
  await expect(owner).toHaveURL(/\/new\?library=.*&entry=/)
  await expect(owner.getByTestId("artifact-source-editor")).toContainText(
    "This exact source is the reusable starting point.",
  )
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
