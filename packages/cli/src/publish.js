// The upload half of `derive publish`, extracted so `derive context push`
// publishes the same way (create-or-version by id) without duplicating the
// collect/zip/request logic.
import { readdirSync, readFileSync, statSync } from "node:fs"
import { basename, join, relative } from "node:path"
import { zipSync } from "fflate"
import { CONFIG_FILE } from "./config.js"

// Secrets never ship: .env and .env.* stay local. .env.example is the one
// conventionally secret-free name, so it travels — it documents what a new
// host must provide.
const isEnvSecret = (name) =>
  name === ".env" || (name.startsWith(".env.") && name !== ".env.example")

/** Recursively collect a directory into {relativePath: bytes} for zipping.
 *  Returns the files plus the .env-rule exclusions in `skipped`, so the caller
 *  can make the "your secrets stayed local" contract visible. `skipTopDirs`
 *  drops named TOP-LEVEL directories (context push uses it for repos/ — the
 *  runner's clone workspace is pointer state, not source). */
export function collectDir(dir, base = dir, out = { files: {}, skipped: [] }, skipTopDirs = []) {
  for (const name of readdirSync(dir)) {
    if (
      name === ".DS_Store" ||
      name === "node_modules" ||
      name.startsWith(".git") ||
      name === CONFIG_FILE
    )
      continue
    const path = join(dir, name)
    if (isEnvSecret(name)) {
      out.skipped.push(relative(base, path).split("\\").join("/"))
      continue
    }
    const st = statSync(path)
    if (st.isDirectory()) {
      if (dir === base && skipTopDirs.includes(name)) continue
      collectDir(path, base, out)
    } else out.files[relative(base, path).split("\\").join("/")] = readFileSync(path)
  }
  return out
}

/** Read the publish target (file or directory) into upload bytes.
 *  Directories zip client-side; the server unpacks them into a bundle. */
export function readTarget(target, skipTopDirs = []) {
  if (statSync(target).isDirectory()) {
    const { files, skipped } = collectDir(target, target, undefined, skipTopDirs)
    if (Object.keys(files).length === 0) throw new Error(`${target} is empty`)
    return { bytes: zipSync(files), filename: `${basename(target)}.zip`, skipped }
  }
  return { bytes: readFileSync(target), filename: basename(target), skipped: [] }
}

/** POST the upload: a new artifact, or a new version when `id` is set.
 *  Returns { res, json } — HTTP-level failures are the caller's to present. */
export async function uploadArtifact(p, bytes, filename, extra = {}) {
  const form = new FormData()
  form.append("file", new Blob([bytes]), filename)
  if (p.title) form.append("title", p.title)
  if (p.slug) form.append("slug", p.slug)
  if (p.spa) form.append("spa", "true")
  if (p.message) form.append("message", p.message)
  if (p.name) form.append("name", p.name)
  if (p.visibility) form.append("visibility", p.visibility)
  // --password gates a public publish behind a passphrase (the server hashes it;
  // the legacy `--visibility password` spelling still maps). Never put it in
  // derive.json (it isn't a config field), only pass it on the command line.
  if (p.password) form.append("password", p.password)
  for (const [k, v] of Object.entries(extra)) form.append(k, v)
  const url = p.id ? `${p.server}/v1/artifacts/${p.id}/versions` : `${p.server}/v1/artifacts`
  const headers = p.token ? { authorization: `Bearer ${p.token}` } : {}
  const res = await fetch(url, { method: "POST", body: form, headers })
  const json = await res.json().catch(() => ({}))
  return { res, json }
}
