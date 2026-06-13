import { type Browser, test as base, expect, type Page } from "@playwright/test"
import {
  activateThread,
  addComment,
  openArtifact,
  proposeEdit,
  publishArtifact,
  signUp,
} from "./helpers"

// Composable fixtures are the project's auth/seed layer. Tests declare what they
// need (`owner`, `secondUser`) and get a ready, isolated state — no per-test
// signup boilerplate, no shared mutable data. Prefer these over a Page Object
// Model: they're keyed to business actions, not raw page mechanics.

export type SecondUser = { page: Page; email: string }

type Fixtures = {
  // A fresh signed-up user. With DOCK_MULTI_WORKSPACE the API gives them their
  // own personal workspace, so each test owns a clean, owner-privileged slate.
  owner: Page
  // A second isolated user in their own browser context — for sharing /
  // collaboration / permission tests. Torn down automatically.
  secondUser: SecondUser
}

export const test = base.extend<Fixtures>({
  owner: async ({ page }, use) => {
    await signUp(page)
    await use(page)
  },
  secondUser: async ({ browser }: { browser: Browser }, use) => {
    const context = await browser.newContext()
    const page = await context.newPage()
    const email = await signUp(page, "Second User")
    await use({ page, email })
    await context.close()
  },
})

export { activateThread, addComment, expect, openArtifact, proposeEdit, publishArtifact, signUp }
