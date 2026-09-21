/**
 * Which URL "Copy link" hands out. A workspace with a claimed domain (its
 * `<label>.<base>` subdomain, or a custom domain) wants its name on the link, so
 * that host wins whenever it can actually serve the artifact to the recipient.
 * The branded host serves raw bytes to an anonymous visitor: no session, no
 * comment or edit surface, no password unlock. So it is only right for a plain
 * view link with no lock; everything else stays on the app URL.
 */
export const pickShareUrl = (args: {
  canonical: string
  domains: { host: string; url: string }[]
  base: string | null
  linkRole: string
  locked: boolean
}): { url: string; host: string | null } => {
  const { canonical, domains, base, linkRole, locked } = args
  if (linkRole !== "viewer" || locked || domains.length === 0) return { url: canonical, host: null }
  // A customer's own domain over the platform subdomain, when both exist.
  const own = base ? domains.find((d) => !d.host.endsWith(`.${base}`)) : undefined
  const pick = own ?? domains[0]
  return pick ? { url: pick.url, host: pick.host } : { url: canonical, host: null }
}
