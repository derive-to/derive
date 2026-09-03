export const NEW_SKILL_PROMPT = `Create a reusable Derive Skill with me.

First, ask exactly one concise question: "What should the Skill do, and when should it trigger?" Then wait for my answer.

After I answer:
- Do not browse, search, or research conventions.
- Immediately publish a NEW multi-file artifact using the Derive publish tool's files payload. Never use the single-file content payload and never try to convert an existing single-file artifact.
- Include exactly two root files: SKILL.md and derive.skill.json.
- SKILL.md must contain YAML frontmatter with name and description, followed by focused, executable instructions.
- derive.skill.json must be valid JSON with {"schema":"derive.skill/v1","catalog":true,"runtime":{"kind":"single"},"relations":{}}.
- Choose a clear short ID from my answer; if it is already taken, create a unique alternative instead of revising the existing artifact.
- Return the published Skill link and nothing else beyond a one-line confirmation.

The result is incomplete unless the published artifact is a multi-file bundle that appears in the Skills catalog.`
