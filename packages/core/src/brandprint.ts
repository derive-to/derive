/**
 * Brandprint resolution. A workspace and a profile each declare how they like their
 * stuff built — a conventions collection (docs/skills agents read) + a visual theme.
 * When an agent acts as a user in a workspace, the two layers merge: workspace is the
 * base, the user's profile refines it (profile wins). Pure (no I/O) so it's unit-tested;
 * the caller loads the actual collection artifacts.
 */
import type { Brandprint, BrandprintTheme } from "./ports"

export interface ResolvedBrandprint {
  /** Conventions collection ids to pull docs from, in precedence order, deduped
   *  (workspace first, the profile's appended). */
  collectionIds: string[]
  /** Visual theme: workspace tokens as the base, profile tokens overriding per key.
   *  Undefined when neither layer set one. */
  theme?: BrandprintTheme
}

const mergeTheme = (ws?: BrandprintTheme, prof?: BrandprintTheme): BrandprintTheme | undefined => {
  if (!ws && !prof) return undefined
  const palette = { ...ws?.palette, ...prof?.palette }
  const fonts = { ...ws?.fonts, ...prof?.fonts }
  const darkPalette = { ...ws?.dark?.palette, ...prof?.dark?.palette }
  const theme: BrandprintTheme = {}
  if (Object.keys(palette).length) theme.palette = palette
  if (Object.keys(fonts).length) theme.fonts = fonts
  if (Object.keys(darkPalette).length) theme.dark = { palette: darkPalette }
  return Object.keys(theme).length ? theme : undefined
}

/** Resolve the workspace + profile Brandprint into the collections to read and the
 *  merged theme (profile over workspace). */
export const resolveBrandprint = (ws?: Brandprint, profile?: Brandprint): ResolvedBrandprint => {
  const ids = [ws?.collectionId, profile?.collectionId].filter((id): id is string => !!id)
  return { collectionIds: [...new Set(ids)], theme: mergeTheme(ws?.theme, profile?.theme) }
}

/** Parse a profile's stored Brandprint JSON string; null / malformed → undefined. */
export const parseBrandprint = (json: string | null | undefined): Brandprint | undefined => {
  if (!json) return undefined
  try {
    const v = JSON.parse(json) as unknown
    return v && typeof v === "object" ? (v as Brandprint) : undefined
  } catch {
    return undefined
  }
}

/** The one-line pointer appended to the MCP server `instructions` when conventions
 *  exist. Progressive disclosure: the agent reads the full docs from the resources. */
export const brandprintInstructions = (docCount: number): string =>
  docCount > 0
    ? ` This workspace has a Brandprint: ${docCount} convention ${docCount === 1 ? "doc" : "docs"} on how to build things here. Read the derive://brandprint/* resources before authoring; your personal Brandprint takes precedence.`
    : ""
