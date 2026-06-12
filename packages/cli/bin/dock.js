#!/usr/bin/env node
// dock — scaffold and publish artifacts to a Dock server.
//   dock init [dir] [--template md|html|slides] [--title t]   scaffold a project
//   dock publish [file|dir] [flags]        publish (reads dock.json if present)
//     flags: --id X --title t --slug s --spa --message m --name "checkpoint"
//            --visibility public|link|org|password --server url --token t
import { readFileSync, readdirSync, statSync } from "node:fs"
import { basename, join, relative } from "node:path"
import { zipSync } from "fflate"
import { CONFIG_FILE, TEMPLATES, loadConfig, resolvePublish, scaffold, writeId } from "../src/config.js"

const args = process.argv.slice(2)
const cmd = args.shift()

const flags = {}
const positional = []
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === "--spa") flags.spa = "true"
  else if (a.startsWith("--")) flags[a.slice(2)] = args[++i]
  else positional.push(a)
}

if (cmd === "init") {
  const dir = positional[0] ?? "."
  const template = flags.template ?? "md"
  if (!TEMPLATES.includes(template)) {
    console.error(`error: unknown template "${template}". Choose: ${TEMPLATES.join(", ")}`)
    process.exit(1)
  }
  const { created, skipped } = scaffold(dir, flags.title ?? "My artifact", template)
  for (const f of created) console.log(`  + ${f}`)
  for (const f of skipped) console.log(`  · ${f} (exists, kept)`)
  const entry = created.find((f) => f !== CONFIG_FILE && f !== "AGENTS.md") ?? "the entry"
  console.log(created.length ? `\nReady (${template}). Edit ${entry}, then run \`dock publish\`.` : `\nNothing to do — ${CONFIG_FILE} already here.`)
  process.exit(0)
}

if (cmd !== "publish") {
  console.error(`usage:
  dock init [dir] [--title t]
  dock publish [file|dir] [--id X] [--title t] [--slug s] [--spa] [--message m] [--name "x"] [--visibility v] [--server url] [--token t]`)
  process.exit(cmd ? 1 : 0)
}

// Merge dock.json (if present in cwd) with flags; flags win.
let config = null
try {
  config = loadConfig(".")
} catch (e) {
  console.error(`error: ${e.message}`)
  process.exit(1)
}
const p = resolvePublish({ ...flags, target: positional[0] }, config)

if (!p.target) {
  console.error(`error: nothing to publish. Pass a file/dir, or set "entry" in ${CONFIG_FILE} (run \`dock init\`).`)
  process.exit(1)
}

const collect = (dir, base, out = {}) => {
  for (const name of readdirSync(dir)) {
    if (name === ".DS_Store" || name === "node_modules" || name.startsWith(".git") || name === CONFIG_FILE) continue
    const path = join(dir, name)
    const st = statSync(path)
    if (st.isDirectory()) collect(path, base, out)
    else out[relative(base, path).split("\\").join("/")] = readFileSync(path)
  }
  return out
}

let bytes
let filename
const st = statSync(p.target)
if (st.isDirectory()) {
  const files = collect(p.target, p.target)
  if (Object.keys(files).length === 0) {
    console.error(`error: ${p.target} is empty`)
    process.exit(1)
  }
  bytes = zipSync(files)
  filename = `${basename(p.target)}.zip`
} else {
  bytes = readFileSync(p.target)
  filename = basename(p.target)
}

const form = new FormData()
form.append("file", new Blob([bytes]), filename)
if (p.title) form.append("title", p.title)
if (p.slug) form.append("slug", p.slug)
if (p.spa) form.append("spa", "true")
if (p.message) form.append("message", p.message)
if (p.name) form.append("name", p.name)
if (p.visibility) form.append("visibility", p.visibility)

const url = p.id ? `${p.server}/v1/artifacts/${p.id}/versions` : `${p.server}/v1/artifacts`
const headers = p.token ? { authorization: `Bearer ${p.token}` } : {}
const res = await fetch(url, { method: "POST", body: form, headers })
const json = await res.json().catch(() => ({}))
if (!res.ok) {
  console.error(`error (${res.status}): ${json.error ?? res.statusText}`)
  process.exit(1)
}

// First publish of a configured project: remember the id so the next publish
// targets the same artifact with zero flags.
let savedId = false
if (!p.id && config && json.short_id) {
  writeId(".", json.short_id)
  savedId = true
}

console.log(`✓ ${json.url}`)
console.log(`  short_id ${json.short_id} · v${json.current_version} · ${json.kind}`)
if (savedId) console.log(`  saved id to ${CONFIG_FILE} — future publishes target this artifact`)
