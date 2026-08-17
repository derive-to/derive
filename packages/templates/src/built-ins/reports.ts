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
      "Review what changed, the leading indicators, blockers, decisions, and commitments.",
    outcome: "Give the team a clear view of the week and its next commitments.",
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
    description:
      "Review customer outcomes, usage, stakeholders, risks, opportunities, and commitments.",
    outcome: "Give the account team a current, evidence-based view of the relationship.",
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
      "Define a market, its segments and players, how they compare, and what is changing.",
    outcome: "Support a product or business decision with a sourced view of the market.",
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
