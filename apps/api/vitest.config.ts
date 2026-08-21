import { readdirSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

const here = dirname(fileURLToPath(import.meta.url))
const TEST_DIR = join(here, "test")

// ---------------------------------------------------------------------------
// TWO PROJECTS, SPLIT ON WHETHER A FILE BUILDS A STORE.
//
// Three quarters of this suite's CPU was module loading, not testing. A full
// local run burns 618 CPU-seconds and the reporter attributes 153s of it to test
// bodies; vitest's own accounting on a 25-file sample says import 69.6s against
// tests 17.5s. Every file forks a fresh worker and re-imports helpers.ts ->
// createApp -> 40 route modules -> 235 source files. The tail is the worst of
// it: 100 of the 253 files do 3.2 SECONDS of test work between them, each behind
// a ~1.8s boot.
//
// `isolate: false` reuses one module graph across the files a worker runs, which
// is the direct fix. It cannot be turned on globally here:
//
//   - helpers.ts keeps `dir`, `meta`, `app`, `anonApp` and a module-load file key
//     at module scope, so one shared instance means one shared store for every
//     file in the worker. 20 of 25 files fail immediately.
//   - Even with a per-file fixture prototype that fixed that, memory grows ~35MB
//     per file and the full suite dies on a heap OOM after 16 files. That growth
//     is fixture retention (app graph + store + blob dir), compounded by a known
//     vitest issue on the 4.x line (vitest-dev/vitest#9492, #9560).
//
// But the files with the worst boot-to-work ratio are exactly the ones that never
// build a store — so they retain nothing, and they do not import helpers.ts at
// all. Splitting on that line takes the whole win with none of the risk.
// Measured over the full 112-file tranche, two runs each:
//
//   isolated       158.0s wall   144.4 CPU-s   import 179.1s   peak RSS 1.19GB
//   isolate:false   62.5s wall    52.8 CPU-s   import  28.4s   peak RSS 1.22GB
//
// Every test in the tranche passes either way, per-file counts diffed identical
// between the two modes, and memory is flat rather than climbing.
//
// The membership is DERIVED, never a hand-kept list: a file is store-backed if it
// reaches test/helpers.ts through any chain of relative imports. Add a helpers
// import to a file and it moves lanes on the next run, with no manifest to drift.
// ---------------------------------------------------------------------------

/** Files under test/ that reach test/helpers.ts through relative imports.
 *
 *  A fixed point over the import graph rather than a memoised DFS. The DFS is the
 *  obvious way to write this and it is subtly wrong: a cycle makes one branch
 *  return "no" before it has really been decided, and memoising that answer can
 *  cache a false negative. Here that would silently drop a store-backed spec out
 *  of the Postgres lane, which nothing would fail to report — the precise drift
 *  this derivation exists to prevent. The fixed point cannot do that: it only ever
 *  ADDS to the reaching set, so it converges to the same answer whatever order the
 *  graph is walked in. */
const storeBacked = (): string[] => {
  const files = readdirSync(TEST_DIR).filter((f) => f.endsWith(".ts"))
  // path -> the relative imports it makes, resolved to extensionless paths.
  const edges = new Map<string, string[]>()
  for (const f of files) {
    const abs = join(TEST_DIR, f)
    let src: string
    try {
      src = readFileSync(abs, "utf8")
    } catch {
      continue
    }
    edges.set(
      abs.replace(/\.ts$/, ""),
      [...src.matchAll(/(?:from|import)\s*["'](\.[^"']*)["']/g)].map((m) =>
        resolve(dirname(abs), (m[1] as string).replace(/\.ts$/, "")),
      ),
    )
  }

  const reaching = new Set([join(TEST_DIR, "helpers")])
  for (let grew = true; grew; ) {
    grew = false
    for (const [file, deps] of edges) {
      if (reaching.has(file)) continue
      if (deps.some((d) => reaching.has(d))) {
        reaching.add(file)
        grew = true
      }
    }
  }

  return files
    .filter((f) => f.endsWith(".test.ts"))
    .filter((f) => reaching.has(join(TEST_DIR, f).replace(/\.ts$/, "")))
    .map((f) => `test/${f}`)
}

const STORE_BACKED = storeBacked()

// test/worker/** belongs to the workerd lane (vitest.worker.config.ts) and must not run here.
// Node picked it up and ran it OUTSIDE workerd, which is the exact silent degradation its
// runtime assertion exists to catch — and did, on the first run after that lane was added.
const EXCLUDE = ["node_modules/**", "dist/**", "test/worker/**"]

const shared = {
  resolve: {
    alias: {
      // `cloudflare:workers` only resolves inside workerd. The Workers entry statically
      // exports its DO classes (wrangler requires it) and one extends Container from
      // @cloudflare/containers, which imports it — so a Node-side test of worker.ts would
      // die on an import unrelated to what it asserts. See the stub for the full note.
      "cloudflare:workers": fileURLToPath(
        new URL("./test/stubs/cloudflare-workers.ts", import.meta.url),
      ),
    },
  },
}

// Coverage is reported, not gated: `pnpm test:coverage` prints a summary and no
// threshold fails on it. The per-package ratchet floors that used to live here
// made every deletion of a weak test a red build, the wrong incentive for a suite
// that is mostly agent-written. The block sits at the root so both projects
// report as one number.
export default defineConfig({
  ...shared,
  test: {
    exclude: EXCLUDE,
    projects: [
      {
        ...shared,
        test: {
          name: "store",
          include: STORE_BACKED,
          exclude: EXCLUDE,
        },
      },
      {
        ...shared,
        test: {
          name: "pure",
          include: ["test/**/*.test.ts"],
          // Everything the `store` project runs, plus the workerd lane.
          exclude: [...EXCLUDE, ...STORE_BACKED],
          // Safe here and only here: these files build no app and no store, so
          // there is no cross-file fixture to leak and nothing accumulating in
          // the worker between files. See the note at the top.
          isolate: false,
        },
      },
    ],
    coverage: {
      provider: "v8",
      // TypeScript only: src/skills/*.md (the MCP skill sources) live under src,
      // and the v8 provider's uncovered-file sweep PARSE_ERRORs trying to read
      // markdown as JS — which exits 1 even with every test green.
      include: ["src/**/*.ts"],
      reporter: ["text-summary"],
    },
  },
})
