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
//   [[queues.producers]]  → the OTHER direction, and the one that was missed. Dropping only the
//                         consumer left the preview POKING production's `derive-runs` queue on
//                         every run-now, with no consumer of its own to answer. So every hosted
//                         run started from a preview was executed by PRODUCTION, running MAIN's
//                         code, against the shared database — the branch under test never ran
//                         its own automations, and a reviewer reading the result was reading
//                         main's behaviour with the PR's name on it. It cost a day of chasing a
//                         "bug" that was only ever main's missing fix. It is also a real
//                         cross-environment leak: a PR's automations executing on production's
//                         deployment with production's credentials.
//
//                         With both gone, `pokeRun` is a no-op and (the cron being stripped too)
//                         a preview's hosted runs simply stay queued. Hosted execution is OFF on
//                         previews, visibly, rather than silently delegated to production.
//   [[containers]]        not needed on the loop substrate, and skips a multi-minute image build.
//   [[send_email]]        a PR preview must never have a live notification transport. Email
//                         exports use the strongly-gated .test capture seam instead.
//   DERIVE_SUBDOMAIN_BASE the *.derive.page vanity host. A preview has no route for it, so a
//                         draft minted here would write a live `domain` row into production's
//                         table and then be served by PRODUCTION — the opposite of the
//                         self-served bytes this config is arranging.
//
// WHAT IT KEEPS: the D1 / Hyperdrive / R2 bindings, so the preview reads and writes the same
// data production does. Weigh that before opening previews to untrusted PRs — see the fork guard
// in .github/workflows/pr-preview.yml.
//
// WHAT IT UNSETS: DERIVE_SANDBOX_URL. Production serves artifact bytes from a separate
// registrable domain (raw.derive.page) and 302s /raw/* there from the app host. A preview
// inherits that var verbatim unless it is stripped — so the preview's /raw/* requests,
// INCLUDING the injected /raw/derive-client.js, are answered by the PRODUCTION deployment.
// The consequence is silent and expensive: any change to the in-iframe client (comment
// anchoring, live cursors, the deck protocol, inline editing) is invisible in every preview,
// because the frame is running production's copy. You review a page that is half the branch
// and half main with nothing on screen saying which half is which.
//
// Unsetting it puts the preview in the single-origin mode DERIVE_SANDBOX_URL itself documents
// as supported ("Unset = single-origin self-host (the iframe sandbox is the wall)"). The two
// inner walls are untouched: the viewer's iframe carries no allow-same-origin, and every
// response serveContent produces carries a `Content-Security-Policy: sandbox` header, so
// artifact HTML lands in an opaque origin with no reach into cookies or storage even when
// opened as a top-level tab. (That is a property of serveContent, NOT of the /raw/* prefix —
// /raw/derive-client.js and the data-slot routes hand-roll their own headers. A new /raw/*
// route serving user bytes must go through serveContent or set RAW_HEADERS itself.)
//
// WHAT THIS COSTS, stated plainly: the origin split also keeps untrusted HTML on a visibly
// different registrable domain from the login form, and that property IS given up here. On a
// preview, an artifact's HTML renders on the same hostname the PR comment invites people to
// sign into, with allow-forms. Storage is still unreachable, but a convincing fake sign-in
// page is not. Previews are built only for same-repo PRs, but their URL is public and
// unauthenticated, so treat a preview like any other place you would not enter a password
// after following a link.
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

const DROP = new Set([
  "[[services]]",
  "[[routes]]",
  "[triggers]",
  "[[queues.consumers]]",
  "[[queues.producers]]",
  "[[containers]]",
  "[[send_email]]",
])
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
out = out.replace(
  `BASE_URL = "${baseUrl}"`,
  `BASE_URL = "${baseUrl}"\nDERIVE_EXPORTS_ONLY = "true"\nDERIVE_QA_EMAIL_CAPTURE = "true"`,
)
// Serve /raw/* from THIS preview instead of 302-ing it to production's sandbox origin —
// otherwise the in-iframe client the preview injects is production's, not the branch's.
// See the header comment for why that is safe here and what it costs.
out = out.replace(
  /^DERIVE_SANDBOX_URL = "[^"]*"$/m,
  "# DERIVE_SANDBOX_URL intentionally unset for previews (preview-config.mjs): /raw/* must be\n" +
    "# served by THIS deployment so the branch's own iframe client is what the frame runs.",
)
// The vanity-subdomain base: a preview has no route for *.derive.page, so a draft minted
// here would write a live `domain` row into production's table and then be served by
// production. Unset it and the draft path falls back to this deployment's own origin.
out = out.replace(
  /^DERIVE_SUBDOMAIN_BASE = "[^"]*"$/m,
  "# DERIVE_SUBDOMAIN_BASE intentionally unset for previews (preview-config.mjs): the vanity\n" +
    "# host has no preview route, and minting one would write a domain row into production.",
)
// Serve on workers.dev — a preview with no hostname is not a preview.
out = out.replace(/^main = "src\/worker\.ts"$/m, 'main = "src/worker.ts"\nworkers_dev = true')

const must = (cond, msg) => {
  if (!cond) {
    console.error(`preview-config: ${msg}`)
    process.exit(1)
  }
}
must(!out.includes("[[routes]]"), "routes survived — the preview would serve production hostnames")
must(
  !out.includes("[[services]]"),
  "service bindings survived — the preview would serve production's public site",
)
must(!out.includes("[triggers]"), "cron survived — a second scheduler on production's rows")
must(!out.includes("queues.consumers"), "queue consumer survived — it would steal run messages")
// The producer is the direction that was missed for a long time: with it, a preview pokes
// PRODUCTION's run queue and production executes the branch's automations with main's code.
must(
  !out.includes("queues.producers"),
  "queue producer survived — the preview would hand its runs to production, which would " +
    "execute them with MAIN's code",
)
// A plain line match, NOT `new RegExp(...${name}...)`. The name arrives on argv, so building a
// pattern out of it is regex injection — a name containing regex metacharacters would change
// what this guard tests, and the guard is the thing standing between a preview and production's
// hostnames. CodeQL flags it (js/regex-injection) and is right to: "CI only ever passes
// derive-pr-<number>" is an argument about today's caller, not about the code.
must(out.split("\n").includes(`name = "${name}"`), "worker name was not replaced")
must(!/^name = "derive"$/m.test(out), "the production worker name is still present")
// POSITIVE assertions. Checking that a particular spelling is ABSENT is not the same as
// checking the edit landed: reformat wrangler.toml (`KEY="v"`, aligned `KEY  = "v"`, a tab, an
// indented table) and the replace matches nothing while an absence-check also matches nothing,
// so the script exits 0 having changed nothing at all — reinstating the exact bug it exists to
// prevent, silently. Assert the marker the replacement WRITES.
must(
  out.includes("DERIVE_SANDBOX_URL intentionally unset for previews"),
  "DERIVE_SANDBOX_URL was not unset (did wrangler.toml's formatting change?) — the preview would serve production's iframe client, hiding every frame-side change under review",
)
must(
  out.includes("DERIVE_SUBDOMAIN_BASE intentionally unset for previews"),
  "DERIVE_SUBDOMAIN_BASE was not unset (did wrangler.toml's formatting change?) — drafts minted on the preview would write domain rows into production",
)
must(/^\[browser\]/m.test(out), "the browser binding was lost — exports would return 503")
must(
  out.includes('name = "PREVIEW_RENDERER"'),
  "the preview-renderer DO was lost — browser-backed exports would never drain",
)
must(
  out.includes('DERIVE_EXPORTS_ONLY = "true"'),
  "export-only isolation was not enabled — the preview could sweep production preview rows",
)
must(
  out.includes('DERIVE_QA_EMAIL_CAPTURE = "true"'),
  "the .test-only email capture seam was not enabled",
)
must(
  !/^\[\[send_email\]\]/m.test(out),
  "live email transport survived — a preview must not send mail",
)
must(
  out.includes(`BASE_URL = "${baseUrl}"`),
  "BASE_URL was not replaced (did wrangler.toml's formatting change?)",
)

process.stdout.write(out)
