import { expect, test } from "../fixtures"

// Settings loads for the owner and the workspace name persists through a save.
test("settings loads for the owner and the workspace name saves", async ({ owner }) => {
  await owner.goto("/settings")
  // Profile is the default section now; switch to Workspace › General for the name.
  await owner.getByTestId("settings-tab-general").click()

  await owner.getByTestId("workspace-name").fill("Acme HQ")
  await owner.getByTestId("workspace-save").click()
  await expect(owner.getByTestId("workspace-name")).toHaveValue("Acme HQ")
})
