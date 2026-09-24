import { test as base } from "@playwright/test"
import { signUp } from "../helpers"
import type { FuzzPages } from "./session"

/** Off unless asked for: `pnpm test:fuzz` sets FUZZ=1 (a bare `playwright test` skips). */
export const FUZZ_ON = !!process.env.FUZZ

/**
 * One signed-up account per worker, reused by every session that worker runs — a
 * fresh signup per session would double the run time. Sessions stay isolated anyway:
 * each publishes its own copy of the fixture deck.
 */
export const test = base.extend<Record<never, never>, { fuzz: FuzzPages }>({
  fuzz: [
    async ({ browser }, use, workerInfo) => {
      const context = await browser.newContext({
        baseURL: workerInfo.project.use.baseURL,
        viewport: { width: 1440, height: 900 },
      })
      const page = await context.newPage()
      // Leaving a session that ended mid-edit (a refused save) prompts; accept it.
      page.on("dialog", (d) => void d.accept().catch(() => {}))
      // The dev servers may be mid-restart (they watch the tree); give signup a retry.
      for (let attempt = 1; ; attempt++) {
        try {
          await signUp(page, "Fuzz Tester")
          break
        } catch (err) {
          if (attempt >= 3) throw err
          await page.waitForTimeout(5_000)
        }
      }
      const render = await context.newPage()
      await render.route("**/*", (route) => route.abort())
      await use({ page, render })
      await context.close()
    },
    { scope: "worker", timeout: 180_000 },
  ],
})

export { expect } from "@playwright/test"
