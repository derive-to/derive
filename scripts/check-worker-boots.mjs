#!/usr/bin/env node
// Guardrail: the deployed Worker must actually BOOT.
//
// workerd evaluates the entry module and everything it statically imports, once at
// startup, in "global scope" — where timers, asynchronous I/O (an awaited fetch,
// connect) and CRYPTOGRAPHIC randomness (crypto.getRandomValues / randomUUID, and
// node:crypto's) are all forbidden. `Math.random()` and `Date.now()` are fine. A
// bundle whose module body does a forbidden one is rejected by the Cloudflare API at
// deploy time: the script never ships, and prod stays on the previous version until
// someone lands a fix.
//
// Nothing else in the pipeline ever instantiates the Worker. `pnpm dev`, `pnpm test`
// and the tsx server run apps/api under NODE, which allows all of them; the workerd
// lane (`pnpm --filter @derive/api test:worker`) picks four library modules across
// three test files and never loads the deployed entry; `wrangler deploy --dry-run`
// bundles without starting an isolate. So the first runtime ever to evaluate `main`
// was production's own `wrangler deploy` — which runs on main only, after merge,
// never on a PR. A module-scope `crypto.randomUUID()` was enough to block a deploy.
//
// This bundles src/worker.ts exactly as the deploy does and starts it in wrangler's
// own pinned workerd: the same engine as production's, at the compatibility date and
// flags read from wrangler.toml, though Cloudflare's build is typically newer. It
// fails with the same error the Cloudflare API returns. ~2s, no network, no
// credentials, no web build, no Docker.
//
// WHAT IT DOES NOT COVER, stated plainly:
//  - An un-awaited module-scope `fetch()` returns a rejected promise instead of
//    throwing, so it boots here — and passes Cloudflare's validation too.
//  - Bindings. Nothing is bound, so a config/script mismatch (a durable_objects
//    class_name that is no longer exported, say) is left to the dry run and the deploy.
//  - `[env.*]` overrides of the compatibility settings; the first match in the file
//    wins, which is the deploy's own behaviour only while no such table exists.
//
// The fix is always the same shape: move the work out of the module body and into
// the handler — a `const` becomes a function, or a lazily-initialised `let`.
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const api = join(root, "apps/api")
// process.exit skips `finally`, so the scratch bundle is cleaned up here instead.
let cleanup = () => {}
const fail = (...lines) => {
  cleanup()
  for (const line of lines) console.error(line)
  process.exit(1)
}

// Compatibility settings come from wrangler.toml so this can never drift from the
// deploy. The date is required — booting on a different one would test a runtime the
// deploy never uses. Flags are genuinely optional in TOML, and none means none, which
// is what the deploy would see too.
const config = readFileSync(join(api, "wrangler.toml"), "utf8")
const compatibilityDate = config.match(/^compatibility_date\s*=\s*"([^"]+)"/m)?.[1]
const compatibilityFlags = (
  config.match(/^compatibility_flags\s*=\s*\[([^\]]*)\]/m)?.[1].match(/"([^"]+)"/g) ?? []
).map((flag) => flag.slice(1, -1))
if (!compatibilityDate)
  fail("worker boots: no compatibility_date in apps/api/wrangler.toml — cannot match the deploy.")

const tmp = mkdtempSync(join(tmpdir(), "derive-worker-boot-"))
const out = join(tmp, "bundle")
// An empty assets directory: the boot check must not require a web build.
const assets = join(tmp, "assets")
mkdirSync(assets)
cleanup = () => rmSync(tmp, { recursive: true, force: true })

try {
  const bundled = spawnSync(
    join(api, "node_modules", ".bin", "wrangler"),
    // --containers-rollout=none: wrangler builds the [[containers]] image even on a
    // dry run, which would put a Docker daemon and a multi-minute cold image pull in
    // front of every commit. None of it reaches the module scope this check reads.
    ["deploy", "--dry-run", "--containers-rollout=none", `--outdir=${out}`, `--assets=${assets}`],
    {
      cwd: api,
      encoding: "utf8",
      env: {
        ...process.env,
        FORCE_COLOR: "0",
        NO_COLOR: "1",
        // A check that runs on every commit must not phone home, and must not add a
        // log file per run to the global wrangler directory forever.
        WRANGLER_SEND_METRICS: "false",
        WRANGLER_SEND_ERROR_REPORTS: "false",
        WRANGLER_LOG_PATH: join(tmp, "wrangler.log"),
      },
    },
  )
  if (bundled.status !== 0)
    fail(
      "worker boots: the Worker did not bundle.\n",
      bundled.stderr || bundled.stdout || String(bundled.error),
    )

  const entry = join(out, "worker.js")
  const fromApi = createRequire(join(api, "package.json"))
  const fromWrangler = createRequire(fromApi.resolve("wrangler/package.json"))
  const { Miniflare, NoOpLog } = await import(pathToFileURL(fromWrangler.resolve("miniflare")))
  const mf = new Miniflare({
    // The startup failure is reported below, mapped back to its source; the
    // runtime's own stderr would only be noise ahead of it. Miniflare still keeps
    // what it needs to build the error this check reads.
    log: new NoOpLog(),
    handleRuntimeStdio: (stdout, stderr) => {
      stdout.resume()
      stderr.resume()
    },
    modulesRoot: out,
    // Listed explicitly: the bundle carries dynamic imports that miniflare's own
    // module collector refuses to walk.
    modules: [{ type: "ESModule", path: entry }],
    compatibilityDate,
    compatibilityFlags,
  })
  try {
    await Promise.race([
      mf.ready,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("workerd did not start within 60s")), 60_000).unref(),
      ),
    ])
  } catch (error) {
    const message = String(error?.cause?.message ?? error?.message ?? error)
    const uncaught = message.match(/Uncaught .*/)?.[0] ?? message
    // esbuild stamps each module with a `// <path>` banner, so the generated line the
    // runtime names walks back to the file that owns it. That location sits on the
    // runtime's next stderr line, not on the message itself.
    const at = message.match(/worker\.js:(\d+):(\d+)/)
    let where = ""
    if (at) {
      const lines = readFileSync(entry, "utf8").split("\n")
      const index = Number(at[1]) - 1
      for (let i = index; i >= 0; i--) {
        // A banner is a lone specifier: it carries a `/`, `.` or `:`. That covers
        // .json and the extensionless virtual modules (`node-built-in-modules:...`,
        // wrangler's unenv polyfills) that anchoring on JS extensions would skip —
        // skipping one blames the module before it — while still rejecting esbuild's
        // `@__PURE__` annotations and any one-word comment in the source.
        const banner = lines[i].match(/^\/\/ (\S*[/.:]\S*)$/)
        if (banner) {
          where = `\n  in ${banner[1]}\n  ${lines[index]?.trim().slice(0, 160)}`
          break
        }
      }
    }
    // Only the global-scope failure gets the global-scope advice. Anything else the
    // runtime refuses to start on — an unknown compatibility flag, say — would be
    // actively misdirected by it.
    const globalScope = /Disallowed operation called within global scope/.test(message)
    fail(
      `worker boots: apps/api/src/worker.ts does not start in workerd.\n\n  ${uncaught}${where}\n`,
      ...(globalScope
        ? [
            "  Module bodies run in global scope, where timers, awaited I/O and cryptographic",
            "  randomness are banned (Math.random and Date.now are fine).",
            "  Move the work into a handler: make the `const` a function, or initialise it lazily.",
          ]
        : [
            "  That is a startup failure rather than a global-scope one — read the error above.",
            "  If it names a compatibility flag, wrangler's pinned workerd is simply older than",
            "  the build Cloudflare validates against, and the deploy itself may be fine.",
          ]),
    )
  } finally {
    await mf.dispose().catch(() => undefined)
  }
} finally {
  cleanup()
}
console.log("worker boots: ok — src/worker.ts evaluates in workerd")
