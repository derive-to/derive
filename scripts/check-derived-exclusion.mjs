#!/usr/bin/env node
// The author-reward surfaces must never show host-derived facts.
//
// Four surfaces exist to pay authors for ASSERTING — the MCP publish receipt, the
// REST publish receipt, the share card, the review deltas — and every version now also carries derived $rows the host
// computed for itself. A reward surface that includes them buries the author's numbers
// under the host's indexes and spends the incentive #580 shipped on self-congratulation.
//
// The filter is one shared helper (assertedOnly, @derive/core derived-facts.ts) so it
// cannot be hand-rolled divergently, and this guard checks each reward call site
// references it BY NAME: an inline filter that happens to be equivalent is
// indistinguishable from a missing one the day someone edits it.
//
// Same construction rules as every guard in this repo, learned the hard way: fail loudly
// when a site can't be found at all (a guard that passes because it looked in the wrong
// place is a claim, not a check), and it was verified against a known-bad input before
// being wired in.
import { readFileSync } from "node:fs"

const REWARD_SITES = [
  {
    file: "apps/api/src/mcp-tools/publish.ts",
    marker: "data_next",
    why: "the publish receipt",
  },
  {
    file: "apps/api/src/lib/unfurl-info.ts",
    marker: "dataSummary",
    why: "the share card",
  },
  {
    file: "apps/api/src/mcp-tools/catch-up.ts",
    marker: "factDeltas",
    why: "the review deltas",
  },
  {
    // Found in a later review round, AFTER the first inventory shipped: the REST 201 body
    // is a publish receipt too, and it dodged the list because it reads rows directly
    // instead of through factSummary. The inventory is the list above — keep auditing it.
    file: "apps/api/src/routes/artifacts.ts",
    marker: "storedSlots",
    why: "the REST publish receipt",
  },
]

const failures = []
let checked = 0

for (const site of REWARD_SITES) {
  let src
  try {
    src = readFileSync(site.file, "utf8")
  } catch {
    failures.push(`${site.file} is missing — the reward-site list is stale`)
    continue
  }
  if (!src.includes(site.marker)) {
    failures.push(
      `${site.file} no longer contains "${site.marker}" — ${site.why} moved and this guard is asserting nothing`,
    )
    continue
  }
  checked++
  if (!src.includes("assertedOnly("))
    failures.push(`${site.file} (${site.why}) does not filter through assertedOnly()`)
}

if (checked === 0 && failures.length === 0) {
  console.error("check-derived-exclusion: found NO reward sites at all — config is stale")
  process.exit(1)
}

if (failures.length) {
  console.error("check-derived-exclusion: a reward surface can show derived facts\n")
  for (const f of failures) console.error(`  ✖ ${f}`)
  console.error(
    "\nReward surfaces pay authors for ASSERTING. Filter rows through assertedOnly() " +
      "(@derive/core) before they reach the receipt, the card, or the deltas — the host " +
      "never congratulates itself through the author's channel.",
  )
  process.exit(1)
}

console.log(`check-derived-exclusion: ok — ${checked} reward surface(s) filter derived facts`)
