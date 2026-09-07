import { expect, test } from "./fixtures"

// The builder page's static promise: both doors render without a model.
// (The conversation itself is model-backed and covered by API tests.)
test("new Context opens the builder with every door", async ({ owner }) => {
  await owner.goto("/contexts")
  await owner.getByTestId("contexts-new-toggle").click()
  await expect(owner).toHaveURL(/\/contexts\/new/)
  await expect(owner.getByTestId("builder-agent-door")).toBeVisible()
  await expect(owner.getByTestId("builder-arxiv-door")).toBeVisible()
  await expect(owner.getByTestId("builder-expert-door")).toBeVisible()
})

// The paper door previews the reference as it is typed and only offers Fetch for a real
// arXiv reference — no network, the same grammar the server applies.
test("the arXiv door reveals the form and previews the reference", async ({ owner }) => {
  await owner.goto("/contexts/new")
  await owner.getByTestId("builder-arxiv-door").click()
  const link = owner.getByTestId("context-arxiv-link")
  await expect(link).toBeVisible()
  await expect(owner.getByTestId("context-arxiv-submit")).toBeDisabled()
  await link.fill("https://example.com/not-a-paper.pdf")
  await expect(owner.getByTestId("context-arxiv-preview")).toHaveText("Not an arXiv link")
  await expect(owner.getByTestId("context-arxiv-submit")).toBeDisabled()
  await link.fill("2401.12345v2")
  await expect(owner.getByTestId("context-arxiv-preview")).toHaveText("arXiv:2401.12345v2")
  await expect(owner.getByTestId("context-arxiv-submit")).toBeEnabled()
  // Opening the other door closes this one.
  await owner.getByTestId("builder-expert-door").click()
  await expect(owner.getByTestId("context-create-name")).toBeVisible()
  await expect(link).toBeHidden()
})

test("the advanced path reveals the manifest form", async ({ owner }) => {
  await owner.goto("/contexts/new")
  await owner.getByTestId("builder-expert-door").click()
  await expect(owner.getByTestId("context-create-name")).toBeVisible()
  await expect(owner.getByTestId("context-create-manifest")).toBeVisible()
})

test("recent Agent URLs redirect to the Context surface", async ({ owner }) => {
  await owner.goto("/agents?name=Analytics&manifest=abc")
  await expect(owner).toHaveURL(/\/contexts\?/)
  const redirected = new URL(owner.url())
  expect(redirected.searchParams.get("name")).toBe("Analytics")
  expect(redirected.searchParams.get("manifest")).toBe("abc")

  await owner.goto("/agents/new")
  await expect(owner).toHaveURL(/\/contexts\/new$/)

  await owner.goto("/agents/ctx_legacy")
  await expect(owner).toHaveURL(/\/contexts\/ctx_legacy$/)
})
