import type { TemplateDefinition } from "../types"
import { input } from "./input"

export const SITE_TEMPLATE_DEFINITIONS: readonly TemplateDefinition[] = [
  {
    id: "project-hub",
    kind: "artifact",
    category: "Site",
    format: "html",
    title: "Project hub",
    defaultTitle: "Project hub",
    description:
      "A living front door for the brief, status, milestones, decisions, artifacts, and people.",
    outcome: "Give a project one understandable home without replacing its working tools.",
    sections: ["Brief", "Now", "Milestones", "Decisions", "Artifacts", "People", "Update history"],
    inputs: [
      input("Project", "Project name", true),
      input("Outcome", "What success changes"),
      input("Artifacts", "The work this hub should point to"),
    ],
    tags: ["project", "hub", "site"],
  },
  {
    id: "launch-page",
    kind: "artifact",
    category: "Site",
    format: "html",
    title: "Launch page",
    defaultTitle: "Launch page",
    description:
      "A focused single-page story with value, proof, product explanation, detail, and action.",
    outcome: "Make the value obvious before asking the visitor to understand the machinery.",
    sections: ["Value proposition", "Proof", "How it works", "Use cases", "Details", "Action"],
    inputs: [
      input("Offer", "What is available?", true),
      input("Audience", "Who should care?", true),
      input("Proof", "Evidence, quote, or result"),
    ],
    tags: ["launch", "marketing", "site"],
  },
]
