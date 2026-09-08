import { mkdirSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import lockfile from "proper-lockfile"

// Keep each parser's read/modify/write cycle exclusive through its final upload.
// Separate locks let the generic scan delegate to the ordinary Skill scan command.
export async function lockScan(kind) {
  const root = process.env.DERIVE_CONFIG_DIR ?? join(homedir(), ".config", "derive")
  mkdirSync(root, { recursive: true })
  return lockfile.lock(join(realpathSync(root), `${kind}-scan`), {
    realpath: false,
    stale: 120_000,
    update: 10_000,
    retries: 0,
  })
}
