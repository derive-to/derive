/**
 * THE WIRE VIEW of a guided-builder card — the strip that every read-out path shares.
 *
 * The card is STORED whole on the agent message (see `StoredBuilderCard` in
 * context-builder-tools.ts): the manifest source the person approved, so the next turn can
 * create from that exact text instead of asking the model to write it again, and a pointer to
 * the document already published for it, so a retry after a failed create wires that one up
 * rather than publishing a second copy. Neither has ever been part of the client contract, and
 * the manifest source in particular is the one thing the whole guided flow exists to keep out of
 * sight.
 *
 * It lives in its own module, imported by nothing, because both ends need it: the builder that
 * writes cards and the readers that serve them (routes/contexts.ts's `messageJson`, the `use`
 * tool's answer payload). Putting it beside the builder would drag that module's imports into
 * the MCP tool tree and close a dependency cycle — and the one thing this must not be is
 * inconvenient to reach, because a reader that skips it leaks.
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
