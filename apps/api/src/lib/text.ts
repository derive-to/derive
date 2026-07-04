/** Cap `s` to `n` characters, replacing the cut tail with an ellipsis (which counts as
 *  the nth char). Shared by the email / Slack / webhook notification builders. */
export const truncate = (s: string, n: number): string =>
  s.length > n ? `${s.slice(0, n - 1)}…` : s
