import { existsSync } from "node:fs"
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { type BlobByteRange, type BlobStore, sha256Hex } from "@derive/core"
import { assertBlobByteRange } from "./blob-range"

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

  async getRange(key: string, range: BlobByteRange): Promise<Uint8Array | null> {
    assertBlobByteRange(range)
    if (!/^[0-9a-f]{64}$/.test(key)) return null
    if (range.length === 0) return new Uint8Array()
    let file: Awaited<ReturnType<typeof open>>
    try {
      file = await open(this.pathFor(key), "r")
    } catch {
      return null
    }
    try {
      const out = new Uint8Array(range.length)
      const { bytesRead } = await file.read(out, 0, range.length, range.offset)
      return out.slice(0, bytesRead)
    } finally {
      await file.close()
    }
  }

  async has(key: string): Promise<boolean> {
    if (!/^[0-9a-f]{64}$/.test(key)) return false
    return existsSync(this.pathFor(key))
  }
}
