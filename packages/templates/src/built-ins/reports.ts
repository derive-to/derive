import type { TemplateDefinition } from "../types"
import { input } from "./input"

export const REPORT_TEMPLATE_DEFINITIONS: readonly TemplateDefinition[] = [
  {
    id: "weekly-operating-review",
    kind: "artifact",
    category: "Report",
    format: "md",
    title: "Weekly operating review",
    defaultTitle: "Weekly operating review",
    description:
      "What changed, leading indicators, blockers, decisions, commitments, and owner follow-through.",
    outcome: "Run the week from deltas and decisions, not status narration.",
    sections: [
      "Week in one line",
      "What changed",
      "Leading indicators",
      "Blockers",
      "Decisions",
      "Commitments",
      "Carry-over",
    ],
    inputs: [
      input("Week", "Reporting week", true),
      input("Metrics", "Current operating signal"),
      input("Prior review", "Last week's commitments"),
    ],
    tags: ["weekly", "operations", "report"],
  },
  {
    id: "customer-health-report",
    kind: "artifact",
    category: "Report",
    format: "md",
    title: "Customer health report",
    defaultTitle: "Customer health report",
    description: "Outcomes, usage, stakeholder map, risks, opportunities, and mutual commitments.",
    outcome: "See the account as a relationship and outcome system, not a health score.",
    sections: [
      "Executive read",
      "Outcomes",
      "Usage",
      "Stakeholders",
      "Risks",
      "Opportunities",
      "Commitments",
    ],
    inputs: [
      input("Account", "Customer or partner", true),
      input("Evidence", "Notes, usage, and commitments", true),
      input("Period", "Review window"),
    ],
    tags: ["customer", "account", "report"],
  },
  {
    id: "market-landscape",
    kind: "artifact",
    category: "Report",
    format: "md",
    title: "Market landscape",
    defaultTitle: "Market landscape",
    description:
      "Category definition, forces, segments, players, comparison method, whitespace, and implications.",
    outcome: "Replace logo maps with a defensible view of how a market is moving.",
    sections: [
      "Category",
      "Forces",
      "Segments",
      "Players",
      "Comparison",
      "Whitespace",
      "Implications",
      "Sources",
    ],
    inputs: [
      input("Market", "The category being studied", true),
      input("Question", "What decision should this inform?"),
      input("Sources", "Research artifacts or links"),
    ],
    tags: ["market", "competitive", "report"],
  },
]
