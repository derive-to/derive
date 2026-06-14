import { Buffer } from "node:buffer"
import type { Page } from "@playwright/test"
import { expect, openArtifact, test } from "../fixtures"

// "Who's viewing" is an avatar stack that opens a popover listing each live viewer
// with their server-derived identity: name, email (signed-in only), and role.

async function publishPublic(page: Page): Promise<string> {
  let id = ""
  await expect(async () => {
    const res = await page.request.post("/v1/artifacts", {
      multipart: {
        file: { name: "p.md", mimeType: "text/markdown", buffer: Buffer.from("# Shared\n\nbody") },
        visibility: "public",
      },
    })
    expect(res.ok(), `publish failed: ${res.status()}`).toBeTruthy()
    id = ((await res.json()) as { short_id: string }).short_id
  }).toPass({ timeout: 10_000 })
  return id
}

test("the presence stack opens a popover listing each viewer with name, email, and role", async ({
  owner,
  secondUser,
}) => {
  const id = await publishPublic(owner)
  await openArtifact(owner, id)

  // A second account opens the same artifact → they join presence (heartbeat).
  await secondUser.page.goto(`/a/${id}`)
  await expect(secondUser.page.getByText("Comments", { exact: true })).toBeVisible()

  // The owner now sees the stack (someone else is viewing) and opens it.
  await expect(owner.getByTestId("presence-trigger")).toBeVisible({ timeout: 15_000 })
  await owner.getByTestId("presence-trigger").click()
  const pop = owner.getByTestId("presence-popover")
  await expect(pop).toBeVisible()

  // The second user shows by their server-derived account name + email.
  await expect(pop).toContainText("Second User")
  await expect(pop).toContainText(secondUser.email)
  // The owner is flagged as themselves, with the owner role on their own artifact.
  await expect(pop.getByText("(you)")).toBeVisible()
  await expect(pop).toContainText("owner")
  // The anonymous-or-not distinction: the second user (a non-member on a public
  // artifact) is a viewer.
  await expect(pop).toContainText("viewer")
})
