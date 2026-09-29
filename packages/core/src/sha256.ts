/**
 * SHA-256, synchronous and incremental. WebCrypto's digest is one async call per input,
 * which is right for one large input and ruinous for tens of thousands of small ones (a
 * source map hashes every element of a document; each call costs more in scheduling than
 * in hashing). This is the standard FIPS 180-4 construction, checked against WebCrypto in
 * the tests. Internal: not exported from the package index.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])
const IV = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]
const W = new Int32Array(64)

/** One 64-byte block of `data` at `off` into the state `h`. */
const compress = (h: Int32Array, data: Uint8Array, off: number): void => {
  for (let i = 0; i < 16; i++, off += 4)
    W[i] =
      ((data[off] as number) << 24) |
      ((data[off + 1] as number) << 16) |
      ((data[off + 2] as number) << 8) |
      (data[off + 3] as number)
  for (let i = 16; i < 64; i++) {
    const a = W[i - 15] as number
    const b = W[i - 2] as number
    const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3)
    const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10)
    W[i] = ((W[i - 16] as number) + s0 + (W[i - 7] as number) + s1) | 0
  }
  let a = h[0] as number
  let b = h[1] as number
  let c = h[2] as number
  let d = h[3] as number
  let e = h[4] as number
  let f = h[5] as number
  let g = h[6] as number
  let k = h[7] as number
  for (let i = 0; i < 64; i++) {
    const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))
    const t1 = (k + S1 + ((e & f) ^ (~e & g)) + (K[i] as number) + (W[i] as number)) | 0
    const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))
    const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0
    k = g
    g = f
    f = e
    e = (d + t1) | 0
    d = c
    c = b
    b = a
    a = (t1 + t2) | 0
  }
  h[0] = ((h[0] as number) + a) | 0
  h[1] = ((h[1] as number) + b) | 0
  h[2] = ((h[2] as number) + c) | 0
  h[3] = ((h[3] as number) + d) | 0
  h[4] = ((h[4] as number) + e) | 0
  h[5] = ((h[5] as number) + f) | 0
  h[6] = ((h[6] as number) + g) | 0
  h[7] = ((h[7] as number) + k) | 0
}

/** An incremental SHA-256: `update` any number of times, then `digest` (which resets it). */
export class Sha256 {
  private readonly h = new Int32Array(IV)
  private readonly block = new Uint8Array(64)
  private fill = 0
  private length = 0

  update(data: Uint8Array, start = 0, end = data.length): this {
    this.length += end - start
    let i = start
    if (this.fill) {
      const n = Math.min(64 - this.fill, end - i)
      this.block.set(data.subarray(i, i + n), this.fill)
      this.fill += n
      i += n
      if (this.fill < 64) return this
      compress(this.h, this.block, 0)
      this.fill = 0
    }
    for (; end - i >= 64; i += 64) compress(this.h, data, i)
    if (i < end) {
      this.block.set(data.subarray(i, end), 0)
      this.fill = end - i
    }
    return this
  }

  /** The 32-byte digest of everything since the last digest; the hasher starts over. */
  digest(): Uint8Array {
    const bits = this.length * 8
    const block = this.block
    block[this.fill++] = 0x80
    if (this.fill > 56) {
      block.fill(0, this.fill)
      compress(this.h, block, 0)
      this.fill = 0
    }
    block.fill(0, this.fill, 56)
    const hi = Math.floor(bits / 0x100000000)
    for (let i = 0; i < 4; i++) {
      block[56 + i] = (hi >>> (24 - 8 * i)) & 0xff
      block[60 + i] = (bits >>> (24 - 8 * i)) & 0xff
    }
    compress(this.h, block, 0)
    const out = new Uint8Array(32)
    for (let i = 0; i < 8; i++) {
      const v = this.h[i] as number
      out[4 * i] = v >>> 24
      out[4 * i + 1] = (v >>> 16) & 0xff
      out[4 * i + 2] = (v >>> 8) & 0xff
      out[4 * i + 3] = v & 0xff
    }
    this.h.set(IV)
    this.fill = 0
    this.length = 0
    return out
  }
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"))
/** The first `bytes` bytes of a digest as hex. */
export const hexOf = (digest: Uint8Array, bytes = digest.length): string => {
  let s = ""
  for (let i = 0; i < bytes; i++) s += HEX[digest[i] as number]
  return s
}
