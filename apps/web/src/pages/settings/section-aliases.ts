// Old or misspelled section ids that should land somewhere real instead of
// silently falling back to Profile. Consumed by routes/settings.$section.tsx's
// beforeLoad, which rewrites the URL (the people/brandprint precedent).
//
// Its own module ON PURPOSE: beforeLoad code rides the eager route-tree bundle,
// so anything it imports is on the critical path. Importing this table from
// pages/settings/index.tsx would drag every settings section into the entry
// chunk (it did — the bundle budget caught it).
export const SECTION_ALIASES: Record<string, string> = {
  "model-plans": "accounts",
  // The old agent-connections section: machines are where agents' runners live now.
  agents: "machines",
  // The id was never `brand`; links that guessed it used to strand on Profile.
  brand: "brandprint",
  // GitHub is a standard workspace integration now; old bookmarks land on the single
  // connection surface instead of exposing a retired standalone page.
  github: "integrations",
}

/** Aliases that land on one group of a section, not its top: the target section plus the
 *  group's anchor. Credentials became the Secrets group of Sources. */
export const SECTION_ANCHORS: Record<string, { section: string; hash: string }> = {
  credentials: { section: "sources", hash: "secrets" },
}
