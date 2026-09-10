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
    [{ parent: "onnxruntime-node@1.24.3", kind: "dependencies", version: "0.6.0" }],
    "Re-audit the adm-zip exception: its locked consumer or version changed",
  )
}

console.log("dependency exceptions: audited install boundary holds")
