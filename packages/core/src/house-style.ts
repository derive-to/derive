/**
 * House Style resolution. A workspace and a profile each declare how they like their
 * stuff built — a conventions collection (docs/skills agents read) + a visual theme.
 * When an agent acts as a user in a workspace, the two layers merge: workspace is the
 * base, the user's profile refines it (profile wins). Pure (no I/O) so it's unit-tested;
 * the caller loads the actual collection artifacts.
 */
import type { HouseStyle, ThemeTokens } from "./ports"

export interface ResolvedHouseStyle {
  /** Conventions collection ids to pull docs from, in precedence order, deduped
   *  (workspace first, the profile's appended). */
  collectionIds: string[]
  /** Visual theme: workspace tokens as the base, profile tokens overriding per key.
   *  Undefined when neither layer set one. */
  theme?: ThemeTokens
}

const mergeTheme = (ws?: ThemeTokens, prof?: ThemeTokens): ThemeTokens | undefined => {
  if (!ws && !prof) return undefined
  const palette = { ...ws?.palette, ...prof?.palette }
  const fonts = { ...ws?.fonts, ...prof?.fonts }
  const darkPalette = { ...ws?.dark?.palette, ...prof?.dark?.palette }
  const theme: ThemeTokens = {}
  if (Object.keys(palette).length) theme.palette = palette
  if (Object.keys(fonts).length) theme.fonts = fonts
  if (Object.keys(darkPalette).length) theme.dark = { palette: darkPalette }
  return Object.keys(theme).length ? theme : undefined
}

/** Resolve the workspace + profile House Style into the collections to read and the
 *  merged theme (profile over workspace). */
export const resolveHouseStyle = (ws?: HouseStyle, profile?: HouseStyle): ResolvedHouseStyle => {
  const ids = [ws?.collectionId, profile?.collectionId].filter((id): id is string => !!id)
  return { collectionIds: [...new Set(ids)], theme: mergeTheme(ws?.theme, profile?.theme) }
}

/** Parse a profile's stored House Style JSON string; null / malformed → undefined. */
export const parseHouseStyle = (json: string | null | undefined): HouseStyle | undefined => {
  if (!json) return undefined
  try {
    const v = JSON.parse(json) as unknown
    return v && typeof v === "object" ? (v as HouseStyle) : undefined
  } catch {
    return undefined
  }
}

/** The one-line pointer appended to the MCP server `instructions` when conventions
 *  exist — progressive disclosure: the agent reads the full docs from the resources. */
export const houseStyleInstructions = (docCount: number): string =>
  docCount > 0
    ? ` This workspace has a House Style: ${docCount} convention ${docCount === 1 ? "doc" : "docs"} on how to build things here — read the dock://house-style/* resources before authoring; your personal House Style takes precedence.`
    : ""
