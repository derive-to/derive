#!/usr/bin/env node
// An OSV applicability exception is valid only while its audited boundary holds.
// adm-zip is loaded by ONNX's disabled installer, never its inference runtime.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
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

if (exceptions.some((exception) => exception.id === "GHSA-ch52-4w7c-c8xp")) {
  const patch = "patches/http-cache-semantics@4.2.0.patch"
  const manifest = JSON.parse(read("package.json"))
  assert.equal(manifest.pnpm?.patchedDependencies?.["http-cache-semantics@4.2.0"], patch)
  const digest = createHash("sha256").update(read(patch)).digest("hex")
  assert.equal(
    digest,
    "aafc7d070db0dfe96ba7d9d9983e7bcb475f114c12dee3921e60c0a728cd2858",
    "Re-audit the cache security patch before changing it",
  )
  const lock = parse(read("pnpm-lock.yaml"))
  assert.equal(lock.patchedDependencies?.["http-cache-semantics@4.2.0"]?.hash, digest)
  const docsRequire = createRequire(new URL("../apps/docs/package.json", import.meta.url))
  const astroRequire = createRequire(docsRequire.resolve("astro/package.json"))
  const CachePolicy = astroRequire("http-cache-semantics")
  const request = { url: "https://cache.test/page", method: "GET", headers: { host: "cache.test" } }
  const staleRequest = {
    ...request,
    headers: { ...request.headers, "cache-control": "max-stale=1000000000" },
  }
  for (const headers of [
    { "cache-control": "max-age=60", "set-cookie": "session=fixture" },
    { "cache-control": "private, max-age=60" },
    { "cache-control": "no-cache, max-age=60" },
    { "cache-control": "no-store, max-age=60" },
    { "cache-control": "max-age=0" },
    { "cache-control": "max-age=60", vary: "*" },
  ]) {
    const policy = new CachePolicy(request, { status: 200, headers })
    policy.now = () => Date.now() + 10_000
    assert.equal(
      policy.evaluateRequest(staleRequest).response,
      undefined,
      "A client max-stale must not bypass a zero-freshness restriction",
    )
  }
  const publicPolicy = new CachePolicy(request, {
    status: 200,
    headers: { "cache-control": "public, max-age=1" },
  })
  publicPolicy.now = () => Date.now() + 10_000
  assert.ok(
    publicPolicy.evaluateRequest(staleRequest).response,
    "A valid public response still honors max-stale",
  )
}

console.log("dependency exceptions: audited boundaries and patched cache behavior hold")
