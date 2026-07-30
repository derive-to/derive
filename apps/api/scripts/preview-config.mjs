#!/usr/bin/env node
// Derive a PREVIEW Worker config from wrangler.toml.
//
// A preview is the same Worker under a different name, on its own workers.dev URL, sharing
// production's data. That last part is the point — a preview you cannot sign into, or that
// shows an empty database, tells you nothing about a change — and it is also the reason this
// script is careful about what it strips.
//
// WHAT IT REMOVES, and why each one would otherwise reach production:
//   [[routes]]            derive.to / app.derive.to / derive.page → the preview would SERVE the
//                         real hostnames, which is a takeover, not a preview.
//   [triggers]            the every-minute cron → a second scheduler against the same rows,
//                         materializing and dispatching real automations.
//   [[queues.consumers]]  → the preview would steal run-dispatch messages from production.
//   [[containers]]        not needed on the loop substrate, and skips a multi-minute image build.
//
// WHAT IT KEEPS: the D1 / Hyperdrive / R2 bindings, so the preview reads and writes the same
// data production does. Weigh that before opening previews to untrusted PRs — see the fork guard
// in .github/workflows/pr-preview.yml.
//
//   node scripts/preview-config.mjs <name> <base-url> > wrangler.preview.toml
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const [, , name, baseUrl] = process.argv
if (!name || !baseUrl) {
  console.error("usage: preview-config.mjs <worker-name> <base-url>")
  process.exit(1)
}

const here = dirname(fileURLToPath(import.meta.url))
const text = readFileSync(join(here, "../wrangler.toml"), "utf8")

// Split on top-level table headers, keeping each header's leading comment block with it.
const lines = text.split("\n")
const blocks = []
let cur = []
for (const line of lines) {
  if (/^\[\[?[a-zA-Z]/.test(line)) {
    const lead = []
    while (cur.length && (cur.at(-1).startsWith("#") || cur.at(-1).trim() === ""))
      lead.unshift(cur.pop())
    blocks.push(cur)
    cur = [...lead, line]
  } else cur.push(line)
}
blocks.push(cur)

const DROP = new Set(["[[routes]]", "[triggers]", "[[queues.consumers]]", "[[containers]]"])
const headerOf = (b) => b.find((l) => /^\[\[?[a-zA-Z]/.test(l))?.trim() ?? null

const kept = []
for (const b of blocks) {
  const h = headerOf(b)
  const body = b.join("\n")
  if (h && DROP.has(h)) continue
  // The container's DO binding and its migration go with the container itself.
  if (h === "[[durable_objects.bindings]]" && body.includes('name = "RUN_CONTAINER"')) continue
  if (h === "[[migrations]]" && body.includes('new_sqlite_classes = ["RunContainer"]')) continue
  kept.push(b)
}

let out = kept.map((b) => b.join("\n")).join("\n")
out = out.replace(/^name = "derive"$/m, `name = "${name}"`)
out = out.replace(/^BASE_URL = "https:\/\/derive\.to"$/m, `BASE_URL = "${baseUrl}"`)
// Serve on workers.dev — a preview with no hostname is not a preview.
out = out.replace(/^main = "src\/worker\.ts"$/m, 'main = "src/worker.ts"\nworkers_dev = true')

const must = (cond, msg) => {
  if (!cond) {
    console.error(`preview-config: ${msg}`)
    process.exit(1)
  }
}
must(!out.includes("[[routes]]"), "routes survived — the preview would serve production hostnames")
must(!out.includes("[triggers]"), "cron survived — a second scheduler on production's rows")
must(!out.includes("queues.consumers"), "queue consumer survived — it would steal run messages")
must(new RegExp(`^name = "${name}"$`, "m").test(out), "worker name was not replaced")
must(!/^name = "derive"$/m.test(out), "the production worker name is still present")

process.stdout.write(out)
