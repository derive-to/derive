import { expect, FUZZ_ON, test } from "./fixtures"
import { fuzzSeeds, runSession } from "./session"

/**
 * Round-trip fuzz for inline deck editing (project "editing-fuzz", not in smoke).
 *
 * Each seed is one session on a freshly published copy of the 44-slide fixture. By
 * default (one-slide mode) it stays on one slide: 8–15 random gestures (clicks,
 * cross-element selections, typing, retypes across <br>, Backspace/Delete runs, Enter,
 * ⌘B/⌘I, ⌘A, clicks on empty space, moves of author nodes and of repeated cards by
 * Option+arrow, the pill's arrows or a drag of its name, box resizes) and a save,
 * then 5–8 more on the slide the session picks back up on, and a second save. Classic mode sometimes starts with a Rearrange-panel pass (move / drag /
 * duplicate / delete, then save) and spreads 5–10 gestures over one to three slides
 * with one save. After every
 * save the oracles in oracles.ts judge the stored source. A failing seed writes its
 * action log, sources, and screenshots to test-results/fuzz/<seed>/ and the run goes
 * on; the teardown prints the summary (and writes summary.md next to them). FUZZ_OUT
 * moves that directory, e.g. out of a test-results/ another run may clear.
 *
 *   pnpm --filter @derive/web test:fuzz                       # 50 sessions (seeds 1–50)
 *   FUZZ_SESSIONS=200 pnpm --filter @derive/web test:fuzz     # more
 *   FUZZ_BASE_SEED=1000 FUZZ_SESSIONS=200 …                   # a different window
 *   FUZZ_SEED=137 pnpm --filter @derive/web test:fuzz         # replay one seed
 *   FUZZ_SEED=137 FUZZ_MAX_ACTIONS=3 …                        # replay a prefix (shrinking)
 *   FUZZ_ARRANGE=off|on …                                     # force the Rearrange pass
 *   FUZZ_MODE=classic …   # 5–10 changes over 1–3 slides, one save (default: one-slide,
 *                         # 8–15 changes on one slide, save, 5–8 more, save again)
 *   FUZZ_MODE=html-doc …  # the same round trip on a plain HTML article (docs/article.html):
 *                         # one section, 8–15 changes (text gestures, list items, table
 *                         # cells, ⌘Z, moving repeated items), save, 5 more, save again
 *   FUZZ_MODE=markdown …  # the equivalent Markdown doc (docs/article.md), judged on its
 *                         # Markdown source: rendered text, blocks/lines outside the
 *                         # edit untouched, no HTML typed into it
 */

test.skip(!FUZZ_ON, "fuzz runs only with FUZZ=1 (pnpm test:fuzz)")
test.describe.configure({ mode: "parallel" })

const maxActions = process.env.FUZZ_MAX_ACTIONS ? Number(process.env.FUZZ_MAX_ACTIONS) : undefined
const arrange = (process.env.FUZZ_ARRANGE as "on" | "off" | undefined) ?? "auto"
const mode =
  (process.env.FUZZ_MODE as "one-slide" | "classic" | "html-doc" | "markdown" | undefined) ??
  "one-slide"

for (const seed of fuzzSeeds()) {
  test(`seed ${seed}`, async ({ fuzz }) => {
    test.setTimeout(240_000)
    const outDir = test.info().project.outputDir
    const result = await runSession(fuzz, seed, { outDir, maxActions, arrange, mode })
    expect(
      result.failures.map((f) => `[${f.phase}] ${f.oracle}: ${f.signature}`),
      `seed ${seed} failed — see ${outDir}/${seed}/, replay with FUZZ_SEED=${seed}`,
    ).toEqual([])
  })
}
