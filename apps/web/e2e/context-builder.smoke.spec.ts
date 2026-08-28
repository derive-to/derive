import { expect, test } from "./fixtures"

// The builder page's static promise: both doors render without a model.
// (The conversation itself is model-backed and covered by API tests.)
test("new Context opens the builder with both doors", async ({ owner }) => {
  await owner.goto("/contexts")
  await owner.getByTestId("contexts-new-toggle").click()
  await expect(owner).toHaveURL(/\/contexts\/new/)
  await expect(owner.getByTestId("builder-agent-door")).toBeVisible()
  await expect(owner.getByTestId("builder-expert-door")).toBeVisible()
})

test("the advanced path reveals the manifest form", async ({ owner }) => {
  await owner.goto("/contexts/new")
  await owner.getByTestId("builder-expert-door").click()
  await expect(owner.getByTestId("context-create-name")).toBeVisible()
  await expect(owner.getByTestId("context-create-manifest")).toBeVisible()
})

test("recent Agent URLs redirect to the Context surface", async ({ owner }) => {
  await owner.goto("/agents")
  await expect(owner).toHaveURL(/\/contexts$/)

  await owner.goto("/agents/new")
  await expect(owner).toHaveURL(/\/contexts\/new$/)
})
