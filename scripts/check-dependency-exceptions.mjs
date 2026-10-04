#!/usr/bin/env node
// An OSV applicability exception is valid only while its audited boundary holds.
// adm-zip is loaded by ONNX's disabled installer, never its inference runtime.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { parse as parseToml } from "smol-toml"
import { parse } from "yaml"

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8")

const exceptions = parseToml(read("osv-scanner.toml")).IgnoredVulns ?? []
if (exceptions.some((exception) => exception.id === "GHSA-vwc7-r8mq-g2x9")) {
  const manifest = JSON.parse(read("package.json"))
  const workspace = parse(read("pnpm-workspace.yaml"))
  assert.deepEqual(
    manifest.pnpm?.onlyBuiltDependencies,
    [],
    "Re-audit the adm-zip exception before enabling dependency lifecycle scripts",
  )
  for (const key of ["onlyBuiltDependenciesFile", "dangerouslyAllowAllBuilds", "allowBuilds"]) {
    assert.equal(manifest.pnpm[key], undefined, `Re-audit adm-zip before setting pnpm.${key}`)
  }
  for (const key of [
    "onlyBuiltDependencies",
    "onlyBuiltDependenciesFile",
    "dangerouslyAllowAllBuilds",
    "allowBuilds",
  ]) {
    assert.equal(workspace[key], undefined, `Re-audit adm-zip before setting workspace ${key}`)
  }

  const lock = parse(read("pnpm-lock.yaml"))
  const consumers = []
  for (const [parent, entry] of Object.entries({ ...lock.importers, ...lock.snapshots })) {
    for (const kind of ["dependencies", "devDependencies", "optionalDependencies"]) {
      if (entry[kind]?.["adm-zip"] !== undefined)
        consumers.push({ parent, kind, version: entry[kind]["adm-zip"] })
    }
  }
  assert.deepEqual(
    consumers,
    [{ parent: "onnxruntime-node@1.24.3", kind: "dependencies", version: "0.6.1" }],
    "Re-audit the adm-zip exception: its locked consumer or version changed",
  )
}

// Build-time-only advisories: each holds only while its one locked consumer is the audited one.
const lockfile = parse(read("pnpm-lock.yaml"))
const consumersOf = (pkg) => {
  const found = []
  for (const [parent, entry] of Object.entries({ ...lockfile.importers, ...lockfile.snapshots })) {
    for (const kind of ["dependencies", "devDependencies", "optionalDependencies"]) {
      if (entry[kind]?.[pkg] !== undefined) found.push(parent.replace(/\(.*$/, ""))
    }
  }
  return found
}
const buildOnly = {
  "GHSA-vfj7-8cjw-p6xm": { pkg: "braces", consumers: ["micromatch@4.0.8"] },
  "GHSA-ch52-4w7c-c8xp": { pkg: "http-cache-semantics", consumers: ["astro@7.2.8"] },
}
for (const [id, { pkg, consumers }] of Object.entries(buildOnly)) {
  if (exceptions.some((exception) => exception.id === id))
    assert.deepEqual(
      consumersOf(pkg),
      consumers,
      `Re-audit the ${pkg} exception (${id}): its locked consumers changed`,
    )
}
console.log("dependency exceptions: audited install boundary holds")
