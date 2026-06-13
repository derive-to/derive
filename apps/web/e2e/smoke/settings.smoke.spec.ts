import { expect, test } from "../fixtures"

// Settings loads for the owner and the workspace name persists through a save.
test("settings loads for the owner and the workspace name saves", async ({ owner }) => {
  await owner.goto("/settings")
  await expect(owner.getByTestId("settings-tab-workspace")).toBeVisible()

  await owner.getByTestId("workspace-name").fill("Acme HQ")
  await owner.getByTestId("workspace-save").click()
  await expect(owner.getByTestId("workspace-name")).toHaveValue("Acme HQ")
})
