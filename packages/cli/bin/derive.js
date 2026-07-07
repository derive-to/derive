#!/usr/bin/env node
// derive — scaffold, publish, and run the review loop against a Derive server.
//   derive init [dir] [--template md|html|slides|site] [--title t]
//   derive login [--local] [--server url]   OAuth sign-in (default https://derive.to); saves a token
//   derive publish [file|dir] [--id --title --slug --spa --message --name --visibility --server --token]
//   derive comments [--id]                 list the artifact's comment threads
//   derive open [short_id] [--id]          open the artifact in a browser
//   derive reply <thread_id> <message…>    reply in a thread
//   derive resolve|reopen <comment_id>     set a thread's state
//   derive status [--id] [--json]          the review round state + open threads
//   derive send-back [--id] [--note m]     (human) return your answers to the agent
//   derive approve [--id] [--note m]       (human) approve — the build go-signal
//   derive runner serve|doctor|install     run a context's answer daemon (npx-able anywhere)
import { spawn } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { basename, join, relative } from "node:path"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import { zipSync } from "fflate"
import {
  CONFIG_FILE,
  formatComments,
  freshToken,
  loadConfig,
  resolvePublish,
  resolveServer,
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
  else if (a === "--review") flags.review = "true"
  else if (a === "--local") flags.local = "true"
  else if (a === "--json") flags.json = "true"
  else if (a === "--mock") flags.mock = "true"
  // Repeatable: `--env-file a --env-file b` stacks (equivalent to --env-file a,b).
  else if (a === "--env-file")
    flags["env-file"] = flags["env-file"] ? `${flags["env-file"]},${args[++i]}` : args[++i]
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
      ? `\nReady (${template}). Edit ${entry}, then run \`derive publish\`.`
      : `\nNothing to do — ${CONFIG_FILE} already here.`,
  )
  process.exit(0)
}

// ---- derive login (OAuth 2.1, PKCE, hosted callback) ------------------------
// The native-app flow without the localhost bounce: register a public client,
// send the user to approve consent in their browser, land on Derive's hosted
// /oauth/cli-callback page, and have them paste the one-time code back here. The
// PKCE verifier never leaves this process, so the exchange (and the resulting
// token) stay bound to this machine.
if (cmd === "login") {
  const b64url = (b) =>
    b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
  const server = resolveServer(flags)
  const redirect = `${server}/oauth/cli-callback`
  const scope =
    flags.scope ??
    "openid offline_access derive:read derive:comment derive:propose derive:publish derive:review"
  const verifier = b64url(randomBytes(64))
  const challenge = b64url(createHash("sha256").update(verifier).digest())
  const state = b64url(randomBytes(16))

  const reg = await fetch(`${server}/api/auth/oauth2/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: flags.name ?? "Derive CLI",
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

  console.log(`\nOpening Derive to authorize (scopes: ${scope}).`)
  console.log(`If your browser doesn't open, visit:\n\n  ${authUrl}\n`)
  const opener =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open"
  spawn(opener, [authUrl], { stdio: "ignore", detached: true })
    .on("error", () => {})
    .unref()

  const code = await new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    rl.question("Paste the code from the Derive page: ", (a) => {
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

  const path = saveToken(server, {
    token: tj.access_token,
    refresh_token: tj.refresh_token,
    client_id: client.client_id,
    expires_in: tj.expires_in,
  })
  console.log(`\n✓ Signed in to ${server}`)
  console.log(`  Token saved to ${path} — \`derive publish\` will use it automatically.`)
  process.exit(0)
}

// ---- derive runner (serve / doctor / install) -------------------------------
// The context runner as a CLI verb: `derive runner serve <ctx>` on any machine
// with Node. Config: flags win over env (DERIVE_SERVER/TOKEN/CONTEXT, RUNNER_*);
// --token-file keeps the secret out of service-unit command lines; --env-file
// loads a context's own secrets (KEY=VALUE) before anything reads them.
if (cmd === "runner") {
  const sub = positional.shift()
  if (!["serve", "doctor", "install"].includes(sub ?? "")) {
    console.error(`usage:
  derive runner serve  [ctx_id] [--server url] [--token t | --token-file f] [--env-file f]
                       [--cwd dir] [--claude-bin path] [--model m] [--poll ms] [--timeout ms] [--mock]
  derive runner doctor [same flags]        preflight: server, token+context, manifest, cwd, claude, gh, python3
  derive runner install [same flags]       print a launchd/systemd unit for this config`)
    process.exit(1)
  }
  const { doctor, loadRunnerConfig, renderServiceUnit, serve } = await import("../src/runner.js")
  if (positional[0]) flags.context = positional[0]
  let rcfg
  try {
    // doctor runs on half-configured machines by design — a missing token or
    // context id is a finding it reports, not a reason it can't start.
    rcfg = loadRunnerConfig(process.env, flags, { partial: sub === "doctor" })
  } catch (e) {
    console.error(`error: ${e.message}`)
    process.exit(1)
  }
  if (sub === "doctor") process.exit((await doctor(rcfg)) === 0 ? 0 : 1)
  if (sub === "install") {
    const binPath = fileURLToPath(import.meta.url)
    // A unit must reference the token, never embed it — and must point at a
    // script that outlives the render. The npx cache does not (`npm cache
    // clean` deletes it and launchd crash-loops on the dead path).
    if (!rcfg.tokenFile) {
      console.error(
        "error: runner install requires --token-file (units reference the token file, they never embed the secret)",
      )
      process.exit(1)
    }
    if (binPath.includes("_npx")) {
      console.error(
        "error: running from the npx cache — install the CLI first (npm i -g @derive-to/cli) so the unit points at a stable path",
      )
      process.exit(1)
    }
    const u = renderServiceUnit(rcfg, binPath)
    console.log(`# Save as ${u.path}, then:\n#   ${u.load}\n\n${u.unit}`)
    process.exit(0)
  }
  try {
    await serve(rcfg) // runs until killed
  } catch (e) {
    // Startup failures (bad token, missing manifest) get the house one-liner,
    // not a stack trace; `runner doctor` is the diagnostic.
    console.error(`error: ${e.message}`)
    process.exit(1)
  }
}

// ---- Loop verbs (comments / open / reply / resolve / reopen) --------------
const LOOP = ["comments", "open", "reply", "resolve", "reopen", "status", "send-back", "approve"]
if (LOOP.includes(cmd)) {
  let cfg = null
  try {
    cfg = loadConfig(".")
  } catch (e) {
    console.error(`error: ${e.message}`)
    process.exit(1)
  }
  const r = resolvePublish(flags, cfg)
  r.token = flags.token ?? process.env.DERIVE_TOKEN ?? (await freshToken(r.server))
  // `derive open <short_id>` / `derive status <short_id>` / `derive comments
  // <short_id>`: a positional id overrides the repo pin — the fallback an agent
  // runs when a publish reports opened_in_tab:false. (reply/resolve keep their
  // positional for the thread/comment id.)
  if (positional[0] && ["open", "status", "comments"].includes(cmd)) r.id = positional[0]
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
      console.error(`usage: derive reply <thread_id> <message…>`)
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

  if (cmd === "status") {
    const res = await fetch(`${base}/review`, { headers: auth })
    if (!res.ok) await die(res)
    const rv = await res.json()
    const cr = await fetch(`${base}/comments?state=open`, { headers: auth })
    const open = cr.ok ? (await cr.json()).comments : []
    if (flags.json) {
      console.log(JSON.stringify({ review: rv.pending, rounds: rv.rounds, open_threads: open }))
      process.exit(0)
    }
    const p = rv.pending
    console.log(
      p
        ? `review: ${p.state} on v${p.version} (requested ${p.created_at})`
        : rv.rounds[0]
          ? `review: ${rv.rounds[0].state} (no round pending)`
          : "review: none requested",
    )
    console.log(`open threads: ${open.length}`)
    for (const c of open) console.log(`  · ${c.thread_id}  ${(c.body_md || "").slice(0, 60)}`)
    process.exit(0)
  }

  if (cmd === "send-back" || cmd === "approve") {
    const path = cmd === "send-back" ? "review/send-back" : "review/approve"
    const res = await fetch(`${base}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify({ note: flags.note ?? "" }),
    })
    if (!res.ok) await die(res)
    const { round } = await res.json()
    console.log(
      `✓ ${cmd === "send-back" ? "sent back to the agent" : "approved"} (round ${round.state})`,
    )
    process.exit(0)
  }

  // resolve | reopen
  const commentId = positional[0]
  if (!commentId) {
    console.error(`usage: derive ${cmd} <comment_id>`)
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
  derive init [dir] [--template md|html|slides|site] [--title t]
  derive login [--local] [--server url]    OAuth sign-in (defaults to https://derive.to); saves a persistent token
  derive publish [file|dir] [--id X] [--title t] [--slug s] [--spa] [--message m] [--name "x"] [--visibility v] [--password p] [--server url] [--token t] [--json]
  derive comments [--id X]                 list comment threads
  derive open [--id X]                     open the artifact in a browser
  derive reply <thread_id> <message…>      reply in a thread
  derive resolve|reopen <comment_id>       set a thread's state
  derive status [--id X] [--json]          review-round state + open threads (the loop's poll target)
  derive send-back [--id X] [--note m]     (human) return your answers to the waiting agent
  derive approve [--id X] [--note m]       (human) approve — the build go-signal
  derive runner serve|doctor|install       run a context's answer daemon (\`derive runner\` for flags)`)
  process.exit(cmd ? 1 : 0)
}

// Merge derive.json (if present in cwd) with flags; flags win.
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
    `error: nothing to publish. Pass a file/dir, or set "entry" in ${CONFIG_FILE} (run \`derive init\`).`,
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
// derive.json (it isn't a config field), only pass it on the command line.
if (p.password) form.append("password", p.password)
if (flags.review) form.append("request_review", "true")

p.token = flags.token ?? process.env.DERIVE_TOKEN ?? (await freshToken(p.server))
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
  console.log(
    `  short_id ${json.short_id} · v${json.current_version} · ${json.kind} · ${json.visibility}`,
  )
  // Publishing is private by default; say so, so nobody mails a URL that 404s
  // for the recipient.
  if (json.visibility === "org" || json.visibility === "private")
    console.log(
      `  ${json.visibility === "org" ? "workspace-only" : "invite-only"} — pass --visibility link (or use the Share dialog) to make the URL readable by others`,
    )
  if (flags.review)
    console.log(`  ↩ review requested — the human reviews in the app, then Send back`)
  if (savedId) console.log(`  saved id to ${CONFIG_FILE} — future publishes target this artifact`)
}
