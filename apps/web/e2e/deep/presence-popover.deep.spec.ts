import { Buffer } from "node:buffer"
import type { Page } from "@playwright/test"
import { expect, openArtifact, test } from "../fixtures"

// "Who's viewing" is an avatar stack that opens a popover listing each live viewer
// with their server-derived identity. Identity is handle-based and PII-free on the
// wire (#171): the public @handle and effective role — never the account name or
// any part of the email (presence reaches anonymous co-viewers over wildcard-CORS
// SSE, so leaking either would be a privacy hole).

async function publishPublic(page: Page): Promise<string> {
  let id = ""
  await expect(async () => {
    const res = await page.request.post("/v1/artifacts", {
      multipart: {
        file: { name: "p.md", mimeType: "text/markdown", buffer: Buffer.from("# Shared\n\nbody") },
        link_role: "viewer",
      },
    })
    expect(res.ok(), `publish failed: ${res.status()}`).toBeTruthy()
    id = ((await res.json()) as { short_id: string }).short_id
  }).toPass({ timeout: 10_000 })
  return id
}

test("the presence stack opens a popover listing each viewer by handle and role", async ({
  owner,
  secondUser,
}) => {
  const id = await publishPublic(owner)
  await openArtifact(owner, id)

  // A second account opens the same artifact → they join presence (heartbeat).
  await secondUser.page.goto(`/artifacts/${id}`)
  await expect(secondUser.page.getByText("Comments", { exact: true })).toBeVisible()

  // The second user's server-assigned public handle — the identity presence shows.
  const session = (await secondUser.page.request
    .get("/api/auth/get-session")
    .then((r) => r.json())) as { user: { username: string } }
  expect(session.user.username).toBeTruthy()

  // The owner now sees the stack (someone else is viewing) and opens it.
  await expect(owner.getByTestId("presence-trigger")).toBeVisible({ timeout: 15_000 })
  await owner.getByTestId("presence-trigger").click()
  const pop = owner.getByTestId("presence-popover")
  await expect(pop).toBeVisible()

  // The second user shows by their public handle — and never by email (the
  // privacy invariant #171 introduced; this is the assertion that guards it).
  await expect(pop).toContainText(session.user.username)
  await expect(pop).not.toContainText(secondUser.email)
  // The owner is flagged as themselves, with the owner role on their own artifact.
  await expect(pop.getByText("(you)")).toBeVisible()
  await expect(pop).toContainText("owner")
  // The anonymous-or-not distinction: the second user (a non-member on a public
  // artifact) is a viewer.
  await expect(pop).toContainText("viewer")
})
