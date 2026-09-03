/**
 * The paper starters and what the CVPR one needs fetched.
 *
 * The starters themselves are generated into latex-templates.gen.ts from
 * packages/core/src/latex-templates/<id>/ (see scripts/gen-latex-templates.mjs). This
 * module is the hand-written half: the ids a surface may ask for, and the pinned upstream
 * files the CVPR starter cannot carry.
 *
 * The CVPR author kit (github.com/cvpr-org/author-kit) publishes `cvpr.sty` and
 * `ieeenat_fullname.bst` without a license, so this repository does not vendor them. A
 * paper created from the template fetches them from a pinned commit into the user's own
 * bundle (user content, like any file they upload), verified against the hashes below, and
 * degrades to a README note when the fetch fails. Bump the commit and hashes together.
 */

import {
  LATEX_TEMPLATES,
  type LatexTemplateFiles,
  type LatexTemplateId,
} from "./latex-templates.gen"

export type { LatexTemplateFiles, LatexTemplateId }

export const LATEX_TEMPLATE_IDS = [
  "acm-siggraph",
  "cvpr",
] as const satisfies readonly LatexTemplateId[]

export const isLatexTemplateId = (id: string): id is LatexTemplateId =>
  (LATEX_TEMPLATE_IDS as readonly string[]).includes(id)

export const latexTemplate = (id: LatexTemplateId): LatexTemplateFiles => LATEX_TEMPLATES[id]

/** What a picker shows: the id, a label and one sentence, never the files. */
export const latexTemplateSummaries = (): {
  id: LatexTemplateId
  label: string
  description: string
}[] =>
  LATEX_TEMPLATE_IDS.map((id) => {
    const t = LATEX_TEMPLATES[id]
    return { id, label: t.label, description: t.description }
  })

export interface PinnedUpstreamFile {
  /** Path inside the paper bundle. */
  path: string
  /** Where the bytes come from: a raw file at a pinned commit, never a branch. */
  url: string
  /** sha256 of the exact bytes; a mismatch is treated as a failed fetch. */
  sha256: string
}

const CVPR_KIT_COMMIT = "291758547e923160eb4d37079b7b9f0dfce82355"
const cvprKitUrl = (path: string): string =>
  `https://raw.githubusercontent.com/cvpr-org/author-kit/${CVPR_KIT_COMMIT}/${path}`

/** The CVPR author kit files a `cvpr` paper needs beside main.tex, pinned. */
export const CVPR_KIT_FILES: readonly PinnedUpstreamFile[] = [
  {
    path: "cvpr.sty",
    url: cvprKitUrl("cvpr.sty"),
    sha256: "2602473285d1a7df2a445ac89b76e1afa0acab78e056f0369d19770245190153",
  },
  {
    path: "ieeenat_fullname.bst",
    url: cvprKitUrl("ieeenat_fullname.bst"),
    sha256: "e38e6166bd7b1e6d23a1b79dcdb55c656e4fcdbe91bdf6b50d827e6b5d1aacfc",
  },
]

/** The upstream files a template needs fetched at creation; empty for self-contained ones. */
export const latexTemplateUpstreamFiles = (id: LatexTemplateId): readonly PinnedUpstreamFile[] =>
  id === "cvpr" ? CVPR_KIT_FILES : []

/** The note a CVPR paper carries when the kit could not be fetched. Shown in the publish
 *  advisories and in the bundle's README, so the author knows before compiling. */
export const CVPR_KIT_MISSING_NOTE =
  "cvpr.sty and ieeenat_fullname.bst could not be fetched from the CVPR author kit; add them from https://github.com/cvpr-org/author-kit next to main.tex before compiling."
