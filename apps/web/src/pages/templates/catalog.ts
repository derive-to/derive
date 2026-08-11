// Templates and Context manifests are portable product data. Keep the web app on
// the exact catalog that MCP reads rather than copying a second definition here.
export {
  ARTIFACT_TEMPLATES,
  BUILT_IN_TEMPLATES,
  CONTEXT_TEMPLATES,
  getTemplate,
  listTemplates,
  TEMPLATE_CATEGORIES,
  templateMatches,
} from "@derive-to/templates"

import type { BuiltInTheme } from "./types"

// Themes are deliberately still local beta UI. PR 2 will move this separate
// catalog and its compatibility rules into the shared package without disturbing
// the Template refs, source bytes, or MCP resources introduced in PR 1.
export const BUILT_IN_THEMES: BuiltInTheme[] = [
  {
    id: "editorial-ink",
    title: "Editorial ink",
    description: "Warm paper, disciplined type, fine rules, and one decisive signal.",
    tone: "Measured · authored · tactile",
    motif: "editorial",
    bestFor: ["Narrative decks", "Strategy", "Research"],
  },
  {
    id: "operator-briefing",
    title: "Operator briefing",
    description: "Dense, neutral, and information-forward for rooms where the numbers lead.",
    tone: "Dense · legible · direct",
    motif: "operator",
    bestFor: ["QBRs", "Board updates", "Reports"],
  },
  {
    id: "field-notes",
    title: "Field notes",
    description: "Spacious observations, documentary rhythm, and room for evidence to breathe.",
    tone: "Observant · human · open",
    motif: "field",
    bestFor: ["Research", "Customer stories", "Project hubs"],
  },
  {
    id: "quiet-institutional",
    title: "Quiet institutional",
    description: "Restrained hierarchy and durable formality without corporate gloss.",
    tone: "Trusted · calm · rigorous",
    motif: "institutional",
    bestFor: ["Board work", "Policy", "Technical plans"],
  },
  {
    id: "high-signal",
    title: "High signal",
    description: "Large scale, sparse composition, and sharp pacing for a spoken room.",
    tone: "Bold · sparse · kinetic",
    motif: "signal",
    bestFor: ["Launches", "Pitches", "Keynotes"],
  },
]

export function getTheme(id: string | undefined): BuiltInTheme | undefined {
  if (!id) return undefined
  return BUILT_IN_THEMES.find((theme) => theme.id === id)
}

export function themeMatches(theme: BuiltInTheme, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return [theme.title, theme.description, theme.tone, ...theme.bestFor]
    .join(" ")
    .toLowerCase()
    .includes(needle)
}
