/** Is a dotted-decimal octet quad in a private / loopback / link-local range? */
function isPrivateV4([a, b]: number[]): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) || // link-local + cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) // CGNAT
  )
}

/**
 * Parse any inet_aton IPv4 form to its four octets, or null if not an IPv4.
 * Covers dotted-decimal AND the bypass forms `curl`/browsers accept: a bare
 * integer (`2130706433`), hex (`0x7f000001`), octal (`0177.0.0.1`), and short
 * dotted forms (`127.1`). Without this, those all read as "not an IP" and slip
 * past the private-range check while still resolving to loopback.
 */
function ipv4Octets(host: string): number[] | null {
  const parts = host.split(".")
  if (parts.length === 0 || parts.length > 4) return null
  const vals: number[] = []
  for (const p of parts) {
    let n: number
    if (/^0x[0-9a-f]+$/i.test(p)) n = Number.parseInt(p.slice(2), 16)
    else if (/^0[0-7]+$/.test(p)) n = Number.parseInt(p, 8)
    else if (p === "0" || /^[1-9][0-9]*$/.test(p)) n = Number.parseInt(p, 10)
    else return null
    if (!Number.isInteger(n) || n < 0) return null
    vals.push(n)
  }
  const k = vals.length
  // The last value fills the remaining low bytes; each leading value is one byte.
  if (vals[k - 1] > 2 ** ((5 - k) * 8) - 1) return null
  let value = vals[k - 1]
  for (let i = 0; i < k - 1; i++) {
    if (vals[i] > 255) return null
    value += vals[i] * 2 ** (24 - i * 8)
  }
  if (value > 0xffffffff) return null
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]
}

/**
 * Reject webhook URLs aimed at private, loopback, or link-local addresses
 * (incl. the cloud metadata endpoint) to blunt SSRF. Literal IPs (in every
 * encoding) + localhost are blocked here; hostnames that resolve into private
 * space (DNS rebinding) are out of scope for this static check.
 */
export function isPublicHttpUrl(raw: string): boolean {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "")
  if (host === "" || host === "localhost" || host.endsWith(".localhost")) return false
  const v4 = ipv4Octets(host)
  if (v4) return !isPrivateV4(v4)
  if (host.includes(":")) {
    if (host === "::1" || host === "::") return false
    if (/^f[cd]/.test(host)) return false // unique-local fc00::/7
    if (/^fe80/.test(host)) return false // link-local
    // IPv4-mapped (::ffff:a.b.c.d). The URL parser rewrites the dotted tail to
    // hex hextets (::ffff:7f00:1), so handle both: decode the embedded v4 and
    // run the private-range check on it.
    const m = host.match(/^::ffff:(.+)$/i)
    if (m) {
      const suf = m[1]
      let oct: number[] | null = null
      if (suf.includes(".")) {
        oct = ipv4Octets(suf)
      } else {
        const g = suf.split(":").map((x) => Number.parseInt(x, 16))
        if (g.every((x) => Number.isInteger(x) && x >= 0 && x <= 0xffff)) {
          const lo = g[g.length - 1]
          const hi = g.length >= 2 ? g[g.length - 2] : 0
          oct = [(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255]
        }
      }
      if (oct && isPrivateV4(oct)) return false
    }
    return true
  }
  return true
}
