// The Rework ⋯ item's four states, resolved from what the signed-in viewer can see
// (workspace settings + their profile + the artifact's addressable agents). Pure so
// the mapping is unit-tested; the component supplies the live query data.
//  - setup:   no Brandprint anywhere — the item routes to /brandprint instead of firing
//  - connect: a Brandprint but no agent — the item opens the Connect-an-agent surface
//  - fire:    exactly one agent — fire immediately
//  - picker:  several agents — open a picker
export type ReworkState = "setup" | "connect" | "fire" | "picker"

export const reworkState = (hasBrandprint: boolean, agentCount: number): ReworkState => {
  if (!hasBrandprint) return "setup"
  if (agentCount === 0) return "connect"
  return agentCount === 1 ? "fire" : "picker"
}
