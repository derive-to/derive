---
name: papers
summary: read an imported arXiv paper and map it to its code (read, publish)
order: 6
---
# Papers: read an imported paper and map it to its code

A workspace can import a paper from arXiv. It is stored as a read-only Context whose one artifact
IS the paper: no manifest beside it, and no runs. `read({ short_id: "ctx_..." })` with the
Context's id returns a summary computed from the paper (title, authors,
abstract, its BibTeX) with `documents` naming the one artifact it lives in. Read that short
id for the full LaTeX source, section by section; its outline carries `citation` (the key
and BibTeX to cite the paper itself). People see the rendered paper and never its source,
which is yours to read: that is how you understand it. While `import.status` is `pending` or
`fetching` the source is still on its way; `failed` and `dead` carry an error code.

A paper may carry the repository that implements it, stored inside the same artifact under
`code/`. The paper's own pages stay the pages; the implementation comes back as `code`
alongside them, with the file count and the shallowest hundred paths. Read any file in it
with `read({ short_id, section: "code/<path>" })`, listed in that sample or not. That is how
you answer what a method actually does rather than what the paper says it does. People never
see these files; you do.

## Mapping a paper to its implementation

A paper that carries its implementation can also carry an **implementation analysis**: a map from
each contribution the paper claims, and each idea its method is built from, to the files, symbols
and lines that carry it out. It is a map, not a review: it says where the paper lives in the code,
not how faithfully the code follows it. When `read({ short_id: "ctx_..." })` shows
`import.analysis`, read that short id (the `analysis` entry in `documents`) before you map the
paper to its code yourself. Its `derive.paper-analysis.json` page is the data; `index.md` is the
same analysis written out for people. `stale: true` means it was made against an arXiv version or
a commit the Context no longer holds: trust it less, and update it.

### Writing one

A person usually starts this by pasting a prompt from the paper's Context page.

1. `read` the Context, then the paper. The paper's outline lists its pages with their heading
   slugs, and `code` lists the implementation.
2. Read the abstract, the introduction and the method. List what the paper contributes, and for
   each contribution the ideas its method is built from: the architecture, the objectives, the
   algorithms, the training and inference procedures, the data handling. A detail is an idea, not
   a number: weights, thresholds, schedules and other hyperparameters belong to the idea they tune.
3. Find where each idea is carried out with `read({ short_id, section: "code/<path>" })`,
   windowing long files with `lines`. Navigate from `code.paths`, entry points and imports: `find`
   scans only the shallowest 50 pages of a bundle, so it misses most of a repository. Check every
   line range and symbol you cite.
4. Give each detail a status by its core idea, as "Choosing a status" says, with `notes` on where
   and how the code carries it out.
5. Publish the analysis as one file, in the Context's workspace and without a `short_id`:
   `publish({ title, files: { "derive.paper-analysis.json": "<the JSON>" } })`. Derive checks it,
   writes `index.md`, gives it the paper's access and links it to the Context.

```json
{
  "schema": "derive.paper-analysis/v1",
  "context": "ctx_...",
  "based_on": null,
  "paper": { "short_id": "<the paper's short id>", "arxiv_version": 2 },
  "implementation": { "repository": "github.com/owner/repo", "commit": "<import.code.commit, or null>" },
  "summary": "Two or three sentences on where the paper's contributions live in the code.",
  "contributions": [
    {
      "id": "c1",
      "title": "What the paper contributes",
      "claim": "What it claims, in a sentence or two.",
      "paper": [{ "section": "main.tex#method", "label": "eq:loss" }],
      "details": [
        {
          "id": "c1.d1",
          "title": "One idea of the method",
          "paper": [{ "section": "main.tex#method" }],
          "code": [{ "path": "src/model.py", "symbol": "class Encoder", "lines": "40-88" }],
          "status": "implemented",
          "notes": "Where and how the code carries out the idea."
        }
      ]
    }
  ],
  "unmapped": [{ "id": "u1", "path": "src/kernels.py", "notes": "Code the paper does not describe." }],
  "open_questions": [{ "id": "q1", "question": "Something you could not locate, or could not tell from the paper and the code." }],
  "removed": []
}
```

### Choosing a status

Judge each detail by its core idea, and treat the rest as details. Code that approximates the
paper counts as the paper's.

- `implemented`: the code carries out the idea, even approximately. Numbers that differ from the
  paper's (weights, thresholds, schedules, iteration counts, initial values), the paper's choice
  being an option rather than the default, extra terms or steps around the idea, and a close
  variant of it (a more general form, an equivalent formulation) all count as implemented.
- `could_not_map`: no code carries out the core idea. It is absent, only part of it is there, or
  a different idea (not a variant of the paper's) takes its place. Name the nearest code when
  there is some, and say in `notes` what you looked for. Other numbers, extra code and
  non-default options never make a detail `could_not_map`.

When you hesitate between the two, choose `implemented`. `notes` say
where and how the code carries the idea out: leave out numbers that differ from the paper, and
name a variant only when a reader needs it to recognise the idea in the code. Do not grade the
code: `summary` says where the contributions live, and `open_questions` are for what you could not
locate or could not tell from the paper and the code, not for doubts about its design.

Derive refuses an analysis that does not hold, listing every problem:

- `context`, `paper` and `implementation` describe what the Context holds now: its id, the
  paper's short id, `import.version`, the repository `import.code.url` names, and
  `import.code.commit` (null when it has none).
- `status` is `implemented` or `could_not_map`. An `implemented` detail names its code; a
  `could_not_map` detail says why in `notes`, and names code only when some is related.
- A code `path` is the repository's own path (`src/model.py`; `code/src/model.py` is accepted too)
  and must exist. `lines` must fit the file, and `symbol` must appear in it, within `lines` when
  given.
- A paper `section` is a page, or `page#slug` from the outline, and a `label` is a `\label` of the
  paper.
- `summary`, `claim`, `notes` and `question` are inline markdown. Refer to code by path, symbol
  and lines, and never paste it: code blocks, HTML, headings, tables and code spans over 80
  characters are refused.
- Ids are short, lowercase and unique (`c1`, `c1.d2`, `u1`, `q1`).

### Updating one

1. Read the analysis, and `catch_up({ short_id })` on it for comments people left.
2. Check what you change against the code, the way you would when writing it, and give every
   detail its status again by "Choosing a status".
3. Publish the whole JSON again with the analysis's `short_id`, `based_on` set to the version you
   read, and a `message` saying what changed and why.

Keep every entry you do not change, under its id. To drop one, list its id in `removed` with the
reason; an entry that disappears without one is refused. `removed` belongs to one version: start
the next update with it empty. Text `edits` and `merge` do not apply to an analysis, and it
cannot be revised outside `publish`. Someone who can only comment leaves a comment on it instead.
