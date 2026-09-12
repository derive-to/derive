import type { BlobWriter } from "./ports"

/**
 * A writer that collects a file and puts it whole: what `BlobStore.writer` comes down to
 * where nothing can stream (a store without it, a runtime without streaming uploads). It
 * holds the entire file, so it belongs only where there is memory for one.
 */
export const bufferedWriter = (
  size: number,
  put: (data: Uint8Array) => Promise<string>,
): BlobWriter => {
  let parts: Uint8Array[] = []
  let written = 0
  return {
    write: async (bytes) => {
      parts.push(bytes)
      written += bytes.byteLength
    },
    close: async () => {
      if (written !== size) throw new Error(`blob stream ended at ${written} of ${size} bytes`)
      const data = new Uint8Array(written)
      let at = 0
      for (const part of parts) {
        data.set(part, at)
        at += part.byteLength
      }
      parts = []
      return put(data)
    },
    abort: async () => {
      parts = []
    },
  }
}
