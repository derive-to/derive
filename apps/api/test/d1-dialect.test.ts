import { describe, expect, it } from "vitest"
import { D1NoTxDialect } from "../src/lib/d1-dialect"

// Regression for the auth-wide hang: kysely-d1's stock driver throws
// "Transactions are not supported yet." on begin/commit/rollback, which leaks
// Better Auth's single D1 connection and wedges every later auth query. The
// no-tx dialect must make those calls resolve instead of throw.
describe("D1NoTxDialect", () => {
  it("neutralises interactive transactions — begin/commit/rollback resolve, never throw", async () => {
    const driver = new D1NoTxDialect({ database: {} as never }).createDriver()
    await expect(driver.beginTransaction({} as never, {} as never)).resolves.toBeUndefined()
    await expect(driver.commitTransaction({} as never)).resolves.toBeUndefined()
    await expect(driver.rollbackTransaction({} as never)).resolves.toBeUndefined()
  })
})
