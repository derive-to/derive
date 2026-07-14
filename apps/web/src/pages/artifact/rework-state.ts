// The Rework ⋯ item's four states, resolved from what the signed-in viewer can see
// (workspace settings + their profile + the artifact's addressable agents). Pure so
// the mapping is unit-tested; the component supplies the live query data. The fire
// state carries its agent (and picker its list) so consumers never re-index the
// array a state was derived from.
//  - setup:   no Brandprint anywhere — the item routes to /brandprint instead of firing
//  - connect: a Brandprint but no agent — the item opens the Connect-an-agent surface
//  - fire:    exactly one agent — fire immediately
//  - picker:  several agents — open a picker
export type ReworkResolution<A> =
  | { state: "setup" }
  | { state: "connect" }
  | { state: "fire"; agent: A }
  | { state: "picker"; agents: A[] }

export const resolveRework = <A>(hasBrandprint: boolean, agents: A[]): ReworkResolution<A> => {
  if (!hasBrandprint) return { state: "setup" }
  const [sole, ...rest] = agents
  if (!sole) return { state: "connect" }
  return rest.length === 0 ? { state: "fire", agent: sole } : { state: "picker", agents }
}
