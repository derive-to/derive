import { createHash, randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { type FileHandle, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { type BlobStore, type BlobWriter, sha256Hex } from "@derive/core"

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
    const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`
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

  async has(key: string): Promise<boolean> {
    if (!/^[0-9a-f]{64}$/.test(key)) return false
    return existsSync(this.pathFor(key))
  }

  /** Stream a file to disk, hashing it on the way, then move it under its key: the same
   *  write-then-rename `put` does, so a reader never sees a partial file. */
  writer(size: number): BlobWriter {
    const hash = createHash("sha256")
    const tmp = join(this.root, `.tmp-${process.pid}-${randomUUID()}`)
    let file: Promise<FileHandle> | null = null
    const opened = (): Promise<FileHandle> => {
      file ??= mkdir(this.root, { recursive: true }).then(() => open(tmp, "w"))
      return file
    }
    let written = 0
    return {
      write: async (bytes) => {
        const handle = await opened()
        hash.update(bytes)
        written += bytes.byteLength
        let at = 0
        while (at < bytes.byteLength) at += (await handle.write(bytes, at)).bytesWritten
      },
      close: async () => {
        await (await opened()).close()
        if (written !== size) {
          await rm(tmp, { force: true })
          throw new Error(`blob stream ended at ${written} of ${size} bytes`)
        }
        const key = hash.digest("hex")
        const path = this.pathFor(key)
        if (existsSync(path)) await rm(tmp, { force: true })
        else {
          await mkdir(join(this.root, key.slice(0, 2)), { recursive: true })
          await rename(tmp, path)
        }
        return key
      },
      abort: async () => {
        if (file) await (await file).close().catch(() => undefined)
        await rm(tmp, { force: true })
      },
    }
  }
}
