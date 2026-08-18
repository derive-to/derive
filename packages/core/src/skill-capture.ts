/**
 * The canned save-as-skill instruction — server-side single source of truth, shared
 * by the copyable prompt (GET /v1/artifacts/:id/save-as-skill) and the one-click ask
 * (POST, the rework-route pattern). Capture exists because team knowledge shows up as
 * review corrections and dies with the thread; this turns one into a workspace skill
 * while the context is still warm.
 *
 * The dedup step is the agent reading the derive://skills catalog, not a server-side
 * similarity call: workspaces hold tens of skills, the catalog is one read, and the
 * extend-or-create judgment needs the existing skills' content anyway.
 *
 * The captured skill publishes LIVE and links its originating thread — skills here
 * are reviewed the way everything else is, by reading and commenting. The deviation
 * footer it plants is the other half of that loop: agents that follow the skill and
 * hit an edge report it as a comment on the skill itself.
 */
export const saveAsSkillInstruction = (
  sourceShortId: string,
  opts: { threadId?: string; note?: string } = {},
): string =>
  `A correction on Derive artifact ${sourceShortId}${
    opts.threadId ? ` (comment thread ${opts.threadId})` : ""
  } is reusable beyond that one document — turn it into a workspace skill. ` +
  `First read the artifact and its threads (catch_up short_id:"${sourceShortId}"), then read ` +
  `derive://skills: if an existing workspace skill already covers this ground, publish a new ` +
  `version extending THAT skill instead of creating a near-duplicate. Otherwise publish a new ` +
  `skill — files {"SKILL.md": ...} with frontmatter \`name\` (short, kebab-case) and ` +
  `\`description\` (one line saying when to use it) — whose body states the rule in plain ` +
  `words and gives one or two concrete before/after examples lifted from the thread. Keep it ` +
  `under a page. End the body with: "If an instruction here didn't fit your situation, leave ` +
  `a comment on this skill saying what you did instead." Publish it live (skills are reviewed ` +
  `by comments, not an approval step), then comment on the NEW skill linking back to ` +
  `${sourceShortId} so reviewers can see where it came from.` +
  (opts.note?.trim() ? `\n\nFrom the requester: ${opts.note.trim()}` : "")
