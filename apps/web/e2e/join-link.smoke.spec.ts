import { expect, test } from "./fixtures"

// The workspace join link end to end: an Admin creates a Creator link in Settings, a second
// person opens it signed out, creates an account from the sign-in prompt, and is joined
// without clicking Join again (?go=1 rides return_to through the auth hand-off). Membership
// is asserted through the owner's API session rather than the joiner's landing page, so
// the test holds whichever screen a brand-new account lands on afterwards.
test("a join link brings a new person into the workspace as a Creator", async ({
  owner,
  browser,
}) => {
  await owner.goto("/settings/members")
  await owner.getByTestId("join-link-create").click()
  const url = await owner.getByTestId("join-link-url").inputValue()
  expect(url).toContain("/join/dkj_")
  await expect(owner.getByTestId("join-link-meta")).toContainText("0 joined")

  // The second person, signed out, in their own browser context.
  const context = await browser.newContext()
  const joiner = await context.newPage()
  try {
    await joiner.goto(new URL(url).pathname)
    await expect(joiner.getByTestId("invite-accept")).toHaveText("Sign in to join")
    await joiner.getByTestId("invite-accept").click()
    await expect(joiner).toHaveURL(/\/login\?.*return_to=/)

    // Create an account right there; return_to carries /join/<token>?go=1 through the hand-off.
    await joiner.getByTestId("login-toggle").click()
    await joiner.getByTestId("login-name").fill("Joiner")
    await joiner.getByTestId("login-email").fill(`e2e+join-${crypto.randomUUID()}@derive.test`)
    await joiner.getByTestId("login-password").fill("e2e-pass-1234")
    await joiner.getByTestId("login-submit").click()

    // The join fires itself on the go=1 landing. Prove it through the owner's session: the
    // link's join count reaches 1 and the roster grows to two.
    await expect(async () => {
      const link = await (await owner.request.get("/v1/workspace/join-link")).json()
      expect(link.join_count).toBe(1)
    }).toPass({ timeout: 30_000 })
    const ws = await (await owner.request.get("/v1/workspace")).json()
    expect(ws.members).toHaveLength(2)
    expect(ws.members.some((m: { role: string }) => m.role === "editor")).toBe(true)

    // And the joiner ends up in the app (a fresh account may pass through /welcome first).
    const skip = joiner.getByTestId("welcome-skip")
    if (await skip.isVisible({ timeout: 15_000 }).catch(() => false)) await skip.click()
    await expect(joiner.getByTestId("library-menu")).toBeVisible({ timeout: 20_000 })
  } finally {
    await context.close()
  }

  // The owner's card reflects the join after a reload.
  await owner.reload()
  await expect(owner.getByTestId("join-link-meta")).toContainText("1 joined")
})
