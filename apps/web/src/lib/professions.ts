// The team roles offered in the profile picker, written casually with a plain-language
// blurb so people self-identify by what they actually do, not a job title. Stored as the
// `value` (free-form underneath: "Other" lets you type anything), so the list can grow
// without a migration. Ordered roughly startup-first. Shared by Settings → Profile and
// the onboarding flow, so the vocabulary can't drift between them.
export const PROFESSIONS: { value: string; hint: string }[] = [
  { value: "Founder", hint: "set the direction and do a bit of everything" },
  { value: "Builder", hint: "generalist: write code, build roadmaps and docs, design stuff" },
  { value: "Product", hint: "shape roadmaps, specs, and what to build next" },
  { value: "Engineering", hint: "write and ship the code" },
  { value: "Design", hint: "craft how it looks and feels" },
  { value: "Marketing", hint: "tell the story and grow the audience" },
  { value: "Other", hint: "something else: type your own" },
]

export const OTHER = "Other"
const PRESET_VALUES = PROFESSIONS.map((p) => p.value)

// Map a stored profession onto the select: a preset matches itself; anything else
// (a custom "Other" value, or a legacy string) lands on "Other" with the text kept.
export const presetFor = (p: string | null): string =>
  !p ? "" : PRESET_VALUES.includes(p) ? p : OTHER
