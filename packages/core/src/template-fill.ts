/**
 * The canned fill-with-your-work instruction — server-side single source of truth,
 * shared by the copyable prompt (GET /v1/artifacts/:id/fill) and the one-click ask
 * (POST, the rework-route pattern). Both channels carry the identical text; only
 * delivery differs, so what the agent is told never depends on how it was reached.
 *
 * The instruction names the copy explicitly (not "this artifact") so the pasted
 * variant is self-sufficient in an agent session with no comment context.
 *
 * Deliberately absent: source lists, required inputs, provider names. The template's
 * own example content shows the agent what the document wants, and the instruction
 * licenses reshaping it — a template is a starting point, and the workspace's real
 * sources are whatever they are.
 */
export const fillInstruction = (
  copyShortId: string,
  templateShortId: string,
  opts: { brandprint: boolean; note?: string },
): string =>
  `Read Derive artifact ${templateShortId} — the template that ${copyShortId} derives from. ` +
  `Publish a new version of ${copyShortId}: keep what makes the template good — its register, ` +
  `its visual system, and any load-bearing structure (a deck's protocol, a facts block) — and ` +
  `treat the structure as a starting point: cut sections there is no real content for, add ` +
  `sections the work needs. Fill it from whatever sources this workspace actually has; assume ` +
  `no particular tool.` +
  (opts.brandprint ? " Apply our brand profile (derive://brandprint/profile)." : "") +
  ` Use real data or leave a visible TODO — never invent a plausible value. Ask what you ` +
  `can't determine.` +
  (opts.note?.trim() ? `\n\nFrom the requester: ${opts.note.trim()}` : "")
