/**
 * THE WIRE VIEW of a guided-builder card — the strip that every read-out path shares.
 *
 * The card is STORED whole on the agent message (see `StoredBuilderCard` in
 * context-builder-tools.ts) because the NEXT turn needs the manifest source the person approved
 * and the document already published for it. Neither has ever been part of the client contract,
 * and the manifest source in particular is the one thing the whole guided flow exists to keep
 * out of sight.
 *
 * Its own module, importing nothing, because both ends need it: the builder that writes cards
 * and the readers that serve them (routes/contexts.ts's `messageJson`, the `use` tool's answer
 * payload). Beside the builder it would drag that module's imports into the MCP tool tree and
 * close a dependency cycle — and the one thing this must not be is inconvenient to reach,
 * because a reader that skips it leaks.
 *
 * Deliberately untyped in and out, and defensive about shape: this runs on rows read back out of
 * the store, which a migration, a hand edit or an older writer could have shaped differently.
 * Dropping unknown internals is the safe failure; passing a manifest through because the row
 * looked odd is not.
 */
export const cardForWire = (card: unknown): unknown => {
  if (!card || typeof card !== "object" || Array.isArray(card)) return card
  const { published_artifact_id: _published, ...rest } = card as Record<string, unknown>
  const draft = rest.draft
  if (!draft || typeof draft !== "object" || Array.isArray(draft)) return rest
  const { manifest_md: _manifest, ...publicDraft } = draft as Record<string, unknown>
  return { ...rest, draft: publicDraft }
}
