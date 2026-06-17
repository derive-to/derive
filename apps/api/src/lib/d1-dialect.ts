import { D1Dialect } from "kysely-d1"

/**
 * A `kysely-d1` dialect with interactive transactions neutralised.
 *
 * Cloudflare D1's binding has no interactive transactions. `kysely-d1`'s driver
 * delegates BEGIN/COMMIT/ROLLBACK to a connection method that just does
 * `throw new Error("Transactions are not supported yet.")`. Better Auth opens a
 * Kysely transaction for some operations (multi-row writes); that throw escapes
 * mid-acquire and leaks Kysely's single D1 connection, so every *later* Better Auth
 * query blocks forever on connection acquisition. The result is the whole auth
 * surface (sign-in, jwks, …) wedging for the life of the isolate — while the app's
 * own D1 store (a separate Kysely instance) keeps working, and a fresh deploy only
 * masks it until the next transaction fires.
 *
 * Make begin/commit/rollback no-ops instead of throwing: `db.transaction()` then runs
 * its callback as a sequence of plain statements. Each D1 statement is already atomic,
 * so the only thing lost is cross-statement atomicity — which Better Auth tolerates
 * (it auto-patches an identical passthrough for adapters that don't implement one).
 */
export class D1NoTxDialect extends D1Dialect {
  override createDriver() {
    const driver = super.createDriver()
    const noTx = (): Promise<void> => Promise.resolve()
    driver.beginTransaction = noTx
    driver.commitTransaction = noTx
    driver.rollbackTransaction = noTx
    return driver
  }
}
