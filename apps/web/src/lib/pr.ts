// Helpers for PR-preview collections. A PR preview's title is stored as
// "PR #<n>: <title>" by the sync engine (see apps/api/src/routes/sync.ts); the UI
// shows the number as its own badge, so strip the redundant prefix from the title.

/** The PR title without the "PR #<n>: " prefix. Falls back to the raw title when it
 *  doesn't match (older rows, or a manually-renamed collection). */
export const prTitle = (title: string, prNumber?: number): string => {
  if (prNumber === undefined) return title
  const stripped = title.match(/^PR #\d+:\s*(.*\S)\s*$/)?.[1]
  return stripped || title
}

/** The pull request's page on GitHub, given a "owner/name" repo + number. */
export const prUrl = (repo: string, prNumber: number): string =>
  `https://github.com/${repo}/pull/${prNumber}`
