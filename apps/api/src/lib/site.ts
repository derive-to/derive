/**
 * The Node tier's stand-in for the edge SITE service binding (worker.ts): proxy a
 * navigation to the public-site origin named by DERIVE_SITE_ORIGIN. Forwards only
 * what a static site can use, and leaves redirects to the browser so the site's
 * trailing-slash 307s and the /guides 308 arrive intact.
 */
const FORWARDED = [
  "accept",
  "accept-encoding",
  "accept-language",
  "if-none-match",
  "if-modified-since",
]

export const originProxy = (origin: string): ((req: Request) => Promise<Response>) => {
  const base = new URL(origin)
  return (req: Request): Promise<Response> => {
    const url = new URL(req.url)
    const headers = new Headers()
    for (const name of FORWARDED) {
      const value = req.headers.get(name)
      if (value) headers.set(name, value)
    }
    return fetch(new URL(url.pathname + url.search, base), {
      method: req.method,
      headers,
      redirect: "manual",
    })
  }
}
