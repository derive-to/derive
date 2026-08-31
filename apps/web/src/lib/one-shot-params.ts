// Pure core of the one-shot URL-param handshake (?checkout=success,
// ?slack_error=…, ?github_connected=…): take the named params out of a search string,
// returning what was taken and the search that should remain. Pure so the
// take-and-strip semantics are unit-testable; the browser wiring (history,
// mount-once) lives in use-one-shot-params.tsx.
export function takeFromSearch(
  search: string,
  names: readonly string[],
): { taken: Record<string, string>; rest: string } {
  const qs = new URLSearchParams(search)
  const taken: Record<string, string> = {}
  for (const name of names) {
    const value = qs.get(name)
    if (value !== null) {
      taken[name] = value
      qs.delete(name)
    }
  }
  return { taken, rest: qs.toString() }
}
