#!/usr/bin/env node
// dock — scaffold, publish, and run the review loop against a Dock server.
//   dock init [dir] [--template md|html|slides|site] [--title t]
//   dock login [--server url] [--scope "…"]   OAuth sign-in; saves a token
//   dock publish [file|dir] [--id --title --slug --spa --message --name --visibility --server --token]
//   dock comments [--id]                 list the artifact's comment threads
//   dock open [--id]                     open the artifact in a browser
//   dock reply <thread_id> <message…>    reply in a thread
//   dock resolve|reopen <comment_id>     set a thread's state
import { spawn } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { basename, join, relative } from "node:path"
import { createInterface } from "node:readline"
import { zipSync } from "fflate"
import {
  CONFIG_FILE,
  formatComments,
  loadConfig,
  resolvePublish,
  saveToken,
  scaffold,
  TEMPLATES,
  writeId,
} from "../src/config.js"

const args = process.argv.slice(2)
const cmd = args.shift()

const flags = {}
const positional = []
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === "--spa") flags.spa = "true"
  else if (a === "--json") flags.json = "true"
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
  console.log(
    created.length
      ? `\nReady (${template}). Edit ${entry}, then run \`dock publish\`.`
      : `\nNothing to do — ${CONFIG_FILE} already here.`,
  )
  process.exit(0)
}

// ---- dock login (OAuth 2.1, PKCE, hosted callback) ------------------------
// The native-app flow without the localhost bounce: register a public client,
// send the user to approve consent in their browser, land on Dock's hosted
// /oauth/cli-callback page, and have them paste the one-time code back here. The
// PKCE verifier never leaves this process, so the exchange (and the resulting
// token) stay bound to this machine.
if (cmd === "login") {
  const b64url = (b) =>
    b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
  const server = (flags.server ?? process.env.DOCK_SERVER ?? "http://localhost:8080").replace(
    /\/+$/,
    "",
  )
  const redirect = `${server}/oauth/cli-callback`
  const scope = flags.scope ?? "openid dock:read dock:publish"
  const verifier = b64url(randomBytes(64))
  const challenge = b64url(createHash("sha256").update(verifier).digest())
  const state = b64url(randomBytes(16))

  const reg = await fetch(`${server}/api/auth/oauth2/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: flags.name ?? "Dock CLI",
      redirect_uris: [redirect],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  }).catch((e) => ({ ok: false, status: 0, json: async () => ({ error: e.message }) }))
  const client = await reg.json().catch(() => ({}))
  if (!reg.ok || !client.client_id) {
    console.error(`error: client registration failed (${reg.status}): ${client.error ?? "unknown"}`)
    process.exit(1)
  }

  const authUrl =
    `${server}/api/auth/oauth2/authorize?response_type=code` +
    `&client_id=${encodeURIComponent(client.client_id)}` +
    `&redirect_uri=${encodeURIComponent(redirect)}` +
    `&scope=${encodeURIComponent(scope)}` +
    `&code_challenge=${challenge}&code_challenge_method=S256&state=${state}`

  console.log(`\nOpening Dock to authorize (scopes: ${scope}).`)
  console.log(`If your browser doesn't open, visit:\n\n  ${authUrl}\n`)
  const opener =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open"
  spawn(opener, [authUrl], { stdio: "ignore", detached: true })
    .on("error", () => {})
    .unref()

  const code = await new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    rl.question("Paste the code from the Dock page: ", (a) => {
      rl.close()
      resolve((a ?? "").trim())
    })
  })
  if (!code) {
    console.error("error: no code entered")
    process.exit(1)
  }

  const tok = await fetch(`${server}/api/auth/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirect,
      client_id: client.client_id,
      code_verifier: verifier,
    }),
  }).catch((e) => ({ ok: false, status: 0, json: async () => ({ error: e.message }) }))
  const tj = await tok.json().catch(() => ({}))
  if (!tok.ok || !tj.access_token) {
    console.error(
      `error: token exchange failed (${tok.status}): ${tj.error_description ?? tj.error ?? "unknown"}`,
    )
    process.exit(1)
  }

  const path = saveToken(server, tj.access_token)
  console.log(`\n✓ Signed in to ${server}`)
  console.log(`  Token saved to ${path} — \`dock publish\` will use it automatically.`)
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
    const opener =
      process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open"
    spawn(opener, [url], { stdio: "ignore", detached: true })
      .on("error", () => {})
      .unref()
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
  dock login [--server url] [--scope "openid dock:read dock:publish"]   OAuth sign-in; saves a token
  dock publish [file|dir] [--id X] [--title t] [--slug s] [--spa] [--message m] [--name "x"] [--visibility v] [--password p] [--server url] [--token t] [--json]
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
  console.error(
    `error: nothing to publish. Pass a file/dir, or set "entry" in ${CONFIG_FILE} (run \`dock init\`).`,
  )
  process.exit(1)
}

const collect = (dir, base, out = {}) => {
  for (const name of readdirSync(dir)) {
    if (
      name === ".DS_Store" ||
      name === "node_modules" ||
      name.startsWith(".git") ||
      name === CONFIG_FILE
    )
      continue
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
// --password is a per-publish secret for `--visibility password`; never put it in
// dock.json (it isn't a config field), only pass it on the command line.
if (p.password) form.append("password", p.password)

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

// `--json`: print the server response only, for scripts + CI (the GitHub Action
// parses this). Otherwise the friendly summary.
if (flags.json) {
  console.log(JSON.stringify(json))
} else {
  console.log(`✓ ${json.url}`)
  console.log(`  short_id ${json.short_id} · v${json.current_version} · ${json.kind}`)
  if (savedId) console.log(`  saved id to ${CONFIG_FILE} — future publishes target this artifact`)
}
