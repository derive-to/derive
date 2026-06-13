#!/usr/bin/env node
// dock — scaffold, publish, and run the review loop against a Dock server.
//   dock init [dir] [--template md|html|slides|site] [--title t]
//   dock publish [file|dir] [--id --title --slug --spa --message --name --visibility --server --token]
//   dock comments [--id]                 list the artifact's comment threads
//   dock open [--id]                     open the artifact in a browser
//   dock reply <thread_id> <message…>    reply in a thread
//   dock resolve|reopen <comment_id>     set a thread's state
import { spawn } from "node:child_process"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { basename, join, relative } from "node:path"
import { zipSync } from "fflate"
import { CONFIG_FILE, TEMPLATES, formatComments, loadConfig, resolvePublish, scaffold, writeId } from "../src/config.js"

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

// ---- Loop verbs (comments / open / reply / resolve / reopen) --------------
const LOOP = ["comments", "open", "reply", "resolve", "reopen"]
if (LOOP.includes(cmd)) {
  let cfg = null
  try {
    cfg = loadConfig(".")
  } catch (e) {
    console.error(`error: ${e.message}`)
    process.exit(1)
  }
  const r = resolvePublish(flags, cfg)
  if (!r.id) {
    console.error(`error: no artifact id. Set "id" in ${CONFIG_FILE} (publish once), or pass --id.`)
    process.exit(1)
  }
  const auth = r.token ? { authorization: `Bearer ${r.token}` } : {}
  const base = `${r.server}/v1/artifacts/${r.id}`
  const die = async (res) => {
    const j = await res.json().catch(() => ({}))
    console.error(`error (${res.status}): ${j.error ?? res.statusText}`)
    process.exit(1)
  }

  if (cmd === "open") {
    const url = `${r.server}/a/${r.id}`
    console.log(url)
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open"
    spawn(opener, [url], { stdio: "ignore", detached: true }).on("error", () => {}).unref()
    process.exit(0)
  }

  if (cmd === "comments") {
    const res = await fetch(`${base}/comments`, { headers: auth })
    if (!res.ok) await die(res)
    console.log(formatComments((await res.json()).comments))
    process.exit(0)
  }

  if (cmd === "reply") {
    const threadId = positional[0]
    const body = positional.slice(1).join(" ")
    if (!threadId || !body) {
      console.error(`usage: dock reply <thread_id> <message…>`)
      process.exit(1)
    }
    const res = await fetch(`${base}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify({ thread_id: threadId, body_md: body }),
    })
    if (!res.ok) await die(res)
    console.log(`✓ replied in ${threadId}`)
    process.exit(0)
  }

  // resolve | reopen
  const commentId = positional[0]
  if (!commentId) {
    console.error(`usage: dock ${cmd} <comment_id>`)
    process.exit(1)
  }
  const res = await fetch(`${base}/comments/${commentId}/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json", ...auth },
    body: JSON.stringify({ state: cmd === "resolve" ? "resolved" : "open" }),
  })
  if (!res.ok) await die(res)
  console.log(`✓ thread ${cmd === "resolve" ? "resolved" : "reopened"}`)
  process.exit(0)
}

if (cmd !== "publish") {
  console.error(`usage:
  dock init [dir] [--template md|html|slides|site] [--title t]
  dock publish [file|dir] [--id X] [--title t] [--slug s] [--spa] [--message m] [--name "x"] [--visibility v] [--server url] [--token t]
  dock comments [--id X]                 list comment threads
  dock open [--id X]                     open the artifact in a browser
  dock reply <thread_id> <message…>      reply in a thread
  dock resolve|reopen <comment_id>       set a thread's state`)
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
