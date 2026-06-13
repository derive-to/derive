import { existsSync } from "node:fs"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { type BlobStore, sha256Hex } from "@dock/core"

/** Content-addressed blobs on the local filesystem. The default store. */
export class FsBlobStore implements BlobStore {
  constructor(private root: string) {}

  private pathFor(key: string): string {
    return join(this.root, key.slice(0, 2), key.slice(2))
  }

  async put(data: Uint8Array): Promise<string> {
    const key = await sha256Hex(data)
    const path = this.pathFor(key)
    if (existsSync(path)) return key
    await mkdir(join(this.root, key.slice(0, 2)), { recursive: true })
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
    await writeFile(tmp, data)
    await rename(tmp, path)
    return key
  }

  async get(key: string): Promise<Uint8Array | null> {
    if (!/^[0-9a-f]{64}$/.test(key)) return null
    try {
      return new Uint8Array(await readFile(this.pathFor(key)))
    } catch {
      return null
    }
  }
}
