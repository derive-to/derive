/** Cap `s` to `n` characters, replacing the cut tail with an ellipsis (which counts as
 *  the nth char). Shared by the email / Slack / webhook notification builders. */
export const truncate = (s: string, n: number): string =>
  s.length > n ? `${s.slice(0, n - 1)}…` : s

/** Point the ROOT-RELATIVE links in markdown at this instance.
 *
 *  Derive's own text links by path (an agent cites `/artifacts/x`, knowing no hostname), and a
 *  relative href means nothing once the text leaves Derive: Slack's mrkdwnBody only linkifies
 *  absolute http(s) targets, and on GitHub it would resolve against github.com. The pattern
 *  stays strict for the same reason it is strict in the web renderer: a leading slash then an
 *  alphanumeric admits /artifacts/x and excludes both `javascript:` and the protocol-relative
 *  `//evil.com`. */
export const absoluteLinks = (md: string, baseUrl: string): string => {
  const base = baseUrl.replace(/\/$/, "")
  return md.replace(
    /\]\((\/[A-Za-z0-9][\w\-./?=&#%]*)\)/g,
    (_m, path: string) => `](${base}${path})`,
  )
}
