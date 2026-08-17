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
      "Bring a project's brief, status, milestones, decisions, artifacts, and people into one page.",
    outcome: "Give the team one place to understand the project and find its work.",
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
      "Build a focused page with the offer, proof, explanation, details, and next action.",
    outcome: "Help visitors understand the offer and decide what to do next.",
    sections: ["Value proposition", "Proof", "How it works", "Use cases", "Details", "Action"],
    inputs: [
      input("Offer", "What is available?", true),
      input("Audience", "Who should care?", true),
      input("Proof", "Evidence, quote, or result"),
    ],
    tags: ["launch", "marketing", "site"],
  },
]
