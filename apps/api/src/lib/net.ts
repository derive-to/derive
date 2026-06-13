/**
 * Reject webhook URLs aimed at private, loopback, or link-local addresses
 * (incl. the cloud metadata endpoint) to blunt SSRF. Literal IPs + localhost are
 * blocked here; hostnames that resolve into private space (DNS rebinding) are
 * out of scope for this static check.
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
  if (host === "" || host === "0.0.0.0" || host === "localhost" || host.endsWith(".localhost"))
    return false
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const o = v4.slice(1).map(Number)
    if (o.some((n) => n > 255)) return false
    const [a, b] = o
    if (a === 0 || a === 10 || a === 127) return false
    if (a === 169 && b === 254) return false // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return false
    if (a === 192 && b === 168) return false
    if (a === 100 && b >= 64 && b <= 127) return false // CGNAT
    return true
  }
  if (host.includes(":")) {
    if (host === "::1" || host === "::") return false
    if (/^f[cd]/.test(host)) return false // unique-local fc00::/7
    if (/^fe80/.test(host)) return false // link-local
    return true
  }
  return true
}
