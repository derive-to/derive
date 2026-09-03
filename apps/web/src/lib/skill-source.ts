import { zipSync } from "fflate"

const FRONTMATTER = /^﻿?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n)*/

export const NEW_SKILL_SOURCE = `---
name: my-skill
description: Describe when an agent should use this Skill.
---

# My skill

Write clear, focused instructions for Claude and Codex.
`

export const skillDisplayName = (title: string | null, name: string): string => {
  const authored = title?.trim()
  if (authored && authored !== name) return authored
  const readable = name.replaceAll("-", " ")
  return readable.charAt(0).toUpperCase() + readable.slice(1)
}

/** The reader hides Skill frontmatter, so its live preview must do the same. */
export const skillPreviewSource = (source: string): string => source.replace(FRONTMATTER, "")

/** A browser-created Skill uses the same portable two-file bundle as every agent client. */
export const skillBundleBytes = (source: string): Uint8Array =>
  zipSync({
    "SKILL.md": new TextEncoder().encode(source),
    "derive.skill.json": new TextEncoder().encode(
      JSON.stringify({
        schema: "derive.skill/v1",
        catalog: true,
        runtime: { kind: "single" },
      }),
    ),
  })
