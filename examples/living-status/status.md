# Agent workflow rollout status

> Official Derive example with illustrative data. Replace the figures, people, links, and
> dates before using it for real work.

- **Decision owner:** Product lead
- **Status:** Needs review
**Current decision:** Keep the rollout limited until two teams complete the full
publish → feedback → revision → approval loop twice.

## Outcome scorecard

| Outcome | Baseline | Current sample | Decision threshold | Source |
| --- | ---: | ---: | ---: | --- |
| Teams completing one full loop | 0 | 2 | 3 | Workspace event query |
| Median time to first review | Unknown | 18 min | Establish baseline | Review-round timestamps |
| Feedback followed by a revision | Unknown | 71% | Establish baseline | Comment and version events |
| Repeat loops within 30 days | Unknown | 1 team | 2 teams | Workspace cohort query |

## What changed

- The second team completed a named approval after two focused revisions.
- One public share generated views but no attributable feedback; it does not count as a
  completed collaborative loop.
- Setup friction moved from MCP connection to choosing the correct workspace.

## Risks and triggers

| Risk | Evidence | Trigger | Owner action |
| --- | --- | --- | --- |
| Review links are viewed but not acted on | View-to-feedback conversion is not yet baselined | Two consecutive loops with no feedback | Interview the reviewer; inspect access and CTA clarity |
| Agents revise without closing threads | One of seven feedback threads remained open | Any approval with an unresolved actionable thread | Block approval or require explicit disposition |
| Setup succeeds only with maintainer help | One assisted connection | More than one assisted setup in the next cohort | Improve the client-specific guide and instrument the failure |

## Decisions requested

1. Approve the current rollout limit or propose a different evidence threshold.
2. Decide whether an unresolved actionable thread should block approval by policy.
3. Name the owner of the workspace-selection improvement.

## Next update contract

Revise this artifact when a threshold changes, a risk trigger fires, or a requested decision
closes. Keep the headings and metric names stable so review comments remain anchorable across
versions.
