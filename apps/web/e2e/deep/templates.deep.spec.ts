import { expect, shareArtifact, test } from "../fixtures"

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
