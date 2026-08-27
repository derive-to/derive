import { expect, test } from "./fixtures"

// The builder page's static promise: both doors render without a model.
// (The conversation itself is model-backed and covered by API tests.)
test("new Agent opens the builder with both doors", async ({ owner }) => {
  await owner.goto("/agents")
  await owner.getByTestId("agents-new-toggle").click()
  await expect(owner).toHaveURL(/\/agents\/new/)
  await expect(owner.getByTestId("builder-agent-door")).toBeVisible()
  await expect(owner.getByTestId("builder-expert-door")).toBeVisible()
})

test("the advanced path reveals the manifest form", async ({ owner }) => {
  await owner.goto("/agents/new")
  await owner.getByTestId("builder-expert-door").click()
  await expect(owner.getByTestId("context-create-name")).toBeVisible()
  await expect(owner.getByTestId("context-create-manifest")).toBeVisible()
})

test("legacy Context URLs redirect to the Agent surface", async ({ owner }) => {
  await owner.goto("/contexts")
  await expect(owner).toHaveURL(/\/agents$/)

  await owner.goto("/contexts/new")
  await expect(owner).toHaveURL(/\/agents\/new$/)
})
