// Old or misspelled section ids that should land somewhere real instead of
// silently falling back to Profile. Consumed by routes/settings.$section.tsx's
// beforeLoad, which rewrites the URL (the people/brandprint precedent).
//
// Its own module ON PURPOSE: beforeLoad code rides the eager route-tree bundle,
// so anything it imports is on the critical path. Importing this table from
// pages/settings/index.tsx would drag every settings section into the entry
// chunk (it did — the bundle budget caught it).
export const SECTION_ALIASES: Record<string, string> = {
  // The id was never `brand`; links that guessed it used to strand on Profile.
  brand: "brandprint",
}
