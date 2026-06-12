#!/usr/bin/env node
// dock — publish HTML, Markdown, or any static build output to a Dock server.
//   dock publish <file|dir> [--id <short_id>] [--title t] [--slug s] [--spa]
//                [--message m] [--name "checkpoint"] [--visibility public|link|org|password]
//                [--server http://localhost:8080] [--token t]
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, basename, relative } from "node:path"
import { zipSync } from "fflate"

const args = process.argv.slice(2)
const cmd = args.shift()

if (cmd !== "publish" || args.length === 0 || args[0].startsWith("--")) {
  console.error(`usage: dock publish <file|dir> [--id X] [--title t] [--slug s] [--spa] [--message m] [--visibility v] [--server url] [--token t]`)
  process.exit(cmd === "publish" ? 1 : cmd ? 1 : 0)
}

const target = args.shift()
const opts = {}
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === "--spa") opts.spa = "true"
  else if (a.startsWith("--")) opts[a.slice(2)] = args[++i]
}
const server = opts.server ?? process.env.DOCK_SERVER ?? "http://localhost:8080"
const token = opts.token ?? process.env.DOCK_TOKEN

const collect = (dir, base, out = {}) => {
  for (const name of readdirSync(dir)) {
    if (name === ".DS_Store" || name === "node_modules" || name.startsWith(".git")) continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) collect(p, base, out)
    else out[relative(base, p).split("\\").join("/")] = readFileSync(p)
  }
  return out
}

let bytes, filename
const st = statSync(target)
if (st.isDirectory()) {
  const files = collect(target, target)
  if (Object.keys(files).length === 0) {
    console.error(`error: ${target} is empty`)
    process.exit(1)
  }
  bytes = zipSync(files)
  filename = `${basename(target)}.zip`
} else {
  bytes = readFileSync(target)
  filename = basename(target)
}

const form = new FormData()
form.append("file", new Blob([bytes]), filename)
for (const k of ["title", "slug", "spa", "message", "visibility", "name"]) if (opts[k]) form.append(k, opts[k])

const url = opts.id
  ? `${server}/v1/artifacts/${opts.id}/versions`
  : `${server}/v1/artifacts`

const headers = token ? { authorization: `Bearer ${token}` } : {}
const res = await fetch(url, { method: "POST", body: form, headers })
const json = await res.json().catch(() => ({}))
if (!res.ok) {
  console.error(`error (${res.status}): ${json.error ?? res.statusText}`)
  process.exit(1)
}
console.log(`✓ ${json.url}`)
console.log(`  short_id ${json.short_id} · v${json.current_version} · ${json.kind}`)
