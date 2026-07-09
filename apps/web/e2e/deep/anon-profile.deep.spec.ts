import { expect, test } from "../fixtures"

// The anon nav rail (the old "Create your own" conversion sidebar) was removed. An
// anonymous visitor on a public profile now gets the chrome-light PublicFrame (brand
// + the growth verbs), never the app rail — the same shareable-without-a-session
// treatment as a public artifact.
test("an anonymous visitor sees a public profile chrome-light, without the app rail", async ({
  owner,
  browser,
}) => {
  const me = (await (await owner.request.get("/v1/me")).json()) as {
    user: { username: string }
  }

  // A truly anonymous visitor — a fresh context with no session.
  const anon = await browser.newContext()
  const page = await anon.newPage()
  try {
    await page.goto(`/users/${me.user.username}`)

    // The profile renders for the anonymous visitor…
    await expect(page.getByTestId("profile-username")).toBeVisible()
    // …inside the public frame (brand + the growth verb)…
    await expect(page.getByTestId("public-make-your-own")).toBeVisible()
    // …and the app nav rail is absent (its rows never render for an anon).
    await expect(page.getByTestId("sidebar-all")).toHaveCount(0)
  } finally {
    await anon.close()
  }
})
