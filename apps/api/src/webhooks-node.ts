import { lookup } from "node:dns/promises"
import { isPrivateAddress } from "./lib/net"
import type { AddressGuard } from "./webhooks"

/**
 * Node delivery guard: resolve the target hostname and refuse if ANY address it
 * maps to is private / loopback / link-local / the cloud metadata endpoint. This is
 * the delivery-time SSRF re-check — a hostname that was public at registration can be
 * rebound to an internal IP by delivery time (DNS rebinding), and the Node/Fly tier
 * sits on a network where those internal IPs are reachable, so the check must run here.
 *
 * Lives in its own module (not webhooks.ts) so the `node:dns` import never reaches the
 * Workers/Durable-Object bundle, which has no DNS and trusts Cloudflare egress instead
 * (see `edgeGuard`). (Undici re-resolves on the fetch that follows, leaving a sub-second
 * TOCTOU window; pinning to the validated IP — which needs an SNI-preserving dispatcher
 * — is the follow-up.)
 */
export const nodeDnsGuard: AddressGuard = {
  async precheck(url) {
    let hostname: string
    try {
      hostname = new URL(url).hostname
    } catch {
      return "invalid url"
    }
    let addrs: { address: string }[]
    try {
      addrs = await lookup(hostname, { all: true })
    } catch {
      return "dns lookup failed"
    }
    if (addrs.some((a) => isPrivateAddress(a.address)))
      return "blocked: resolves to a private address"
    return null
  },
}
