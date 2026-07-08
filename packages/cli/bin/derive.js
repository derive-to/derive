#!/usr/bin/env node
// derive — scaffold, publish, and run the review loop against a Derive server.
//   derive init [dir] [--template md|html|slides|site|skill|context] [--title t]
//   derive login [--local] [--server url] [--workspace w] [--pick] [--add] [--sync] [--manage]
//                                          OAuth sign-in; discovers every workspace
//                                          you belong to. Already signed in? Shows
//                                          a manage menu (or acts on --add/--sync).
//                                          --manage adds the agent/context admin grant.
//   derive accounts [--json]              every signed-in account + its workspaces
//   derive workspaces [--account a]        the resolved account's workspaces
//   derive workspace use <ref> [--account a]      set the default workspace
//   derive workspace forget <ref> [--account a]   drop a workspace locally
//   derive workspace describe <ref> ["text"] [--account a] [--clear]
//                                           set/show/clear what a workspace is FOR
//   derive account use <ref>               set the default account
//   derive logout [--account a] [--all]    sign out
//   derive publish [file|dir] [--id --title --slug --spa --message --name --visibility --server --token --workspace --account]
//   derive comments [--id]                 list the artifact's comment threads
//   derive pull [short_id] [--v N] [--out f]  print an artifact's source (bundles: entry file)
//   derive open [short_id] [--id]          open the artifact in a browser
//   derive reply <thread_id> <message…>    reply in a thread
//   derive resolve|reopen <comment_id>     set a thread's state
//   derive status [--id] [--json]          the review round state + open threads
//   derive send-back [--id] [--note m]     (human) return your answers to the agent
//   derive approve [--id] [--note m]       (human) approve — the build go-signal
//   derive runner serve|doctor|install     run a context's answer daemon (npx-able anywhere)
//   derive context push|dev                ship a context dir as its manifest / tune it live
import { spawn } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import {
  CONFIG_FILE,
  describeWorkspace,
  findAccountWorkspace,
  forgetWorkspace,
  formatComments,
  freshToken,
  getAccount,
  getClientId,
  getDefault,
  listAccounts,
  loadConfig,
  mergeChosenWorkspaces,
  removeAccount,
  resolveAccountRef,
  resolvePublish,
  resolveServer,
  saveAccount,
  saveClientId,
  scaffold,
  setDefaultAccount,
  setDefaultWorkspace,
  setWorkspaces,
  TEMPLATES,
  writeContextConfig,
  writeId,
} from "../src/config.js"
import { createAgent, createContext, saveAgentToken } from "../src/context.js"
import { readTarget, uploadArtifact } from "../src/publish.js"

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
  else if (a === "--pick") flags.pick = "true"
  else if (a === "--add") flags.add = "true"
  else if (a === "--sync") flags.sync = "true"
  else if (a === "--all") flags.all = "true"
  else if (a === "--clear") flags.clear = "true"
  else if (a === "--mock") flags.mock = "true"
  else if (a === "--manage") flags.manage = "true"
  // Repeatable: `--env-file a --env-file b` stacks (equivalent to --env-file a,b).
  else if (a === "--env-file")
    flags["env-file"] = flags["env-file"] ? `${flags["env-file"]},${args[++i]}` : args[++i]
  else if (a.startsWith("--")) flags[a.slice(2)] = args[++i]
  else positional.push(a)
}

// A plain numbered prompt (no arrow-key TUI — matches this CLI's existing
// readline-only style). Returns the chosen option, or null on empty input.
async function promptChoice(question, options) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  options.forEach((o, i) => {
    console.log(`  ${i + 1}) ${o}`)
  })
  const answer = await new Promise((resolve) => rl.question(`${question} `, resolve))
  rl.close()
  const n = Number.parseInt((answer ?? "").trim(), 10)
  return n >= 1 && n <= options.length ? n - 1 : null
}

const opener = () =>
  process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open"
const openBrowser = (url) =>
  spawn(opener(), [url], { stdio: "ignore", detached: true })
    .on("error", () => {})
    .unref()

/** Print the `error: not signed in…` hint shared by every command that needs a
 *  token but found none — a flag/DERIVE_TOKEN always short-circuits this. */
function requireSignedIn(r) {
  if (r.token) return
  console.error(`You are not signed in to ${r.server}.`)
  console.error("  Run  derive login   to connect (opens your browser).")
  process.exit(1)
}

/** Print a resolved `r.workspaceError` (from resolvePublish) and exit — called
 *  before any network request, so a bad --workspace/--account never silently
 *  falls through to the wrong target. */
function requireNoTargetError(r) {
  if (!r.workspaceError) return
  const e = r.workspaceError
  if (e.type === "no_account") console.error(`error: no signed-in account matches "${e.ref}"`)
  else if (e.type === "not_found") console.error(`error: no workspace "${e.ref}" found`)
  else if (e.type === "ambiguous") {
    const who = e.accounts.map((a) => a.handle ?? a.accountId).join(", ")
    console.error(`error: "${e.ref}" exists under more than one account: ${who}`)
    console.error(
      `  Pick one:  --workspace "${e.ref}" --account ${e.accounts[0].handle ?? e.accounts[0].accountId}`,
    )
  }
  process.exit(1)
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
  // The starter the user should open next — not the config/convention files.
  const meta = [CONFIG_FILE, "derive.schema.json", "AGENTS.md", ".gitignore"]
  const entry = created.find((f) => !meta.includes(f) && !f.startsWith(".")) ?? "the entry"
  const next = template === "context" ? "derive context push" : "derive publish"
  console.log(
    created.length
      ? `\nReady (${template}). Edit ${entry}, then run \`${next}\`.`
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
//
// The token this earns is scoped to the SIGNED-IN USER, not one workspace — it
// already reaches every workspace they belong to. So a successful exchange is
// followed by one GET /v1/workspaces to discover the full roster (and the
// account's own id/handle), which is what makes "sign into everything at once"
// true: one browser round trip, every workspace usable immediately after.

const findWorkspaceInMap = (map, ref) => {
  if (map[ref]) return { id: ref, ...map[ref] }
  const wanted = ref.toLowerCase()
  const hit = Object.entries(map).find(([, w]) => w.name.toLowerCase() === wanted)
  return hit ? { id: hit[0], ...hit[1] } : null
}

/** GET /v1/workspaces with a fresh bearer: the caller's own identity (falling
 *  back to a synthetic "default" account for a server too old to report one —
 *  self-hosted instances predating this feature) plus every workspace it
 *  belongs to, as a `{[id]: {name, role}}` map ready for `setWorkspaces`. */
async function fetchWorkspaces(server, token) {
  const res = await fetch(`${server}/v1/workspaces`, {
    headers: { authorization: `Bearer ${token}` },
  })
  const j = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(j.error ?? res.statusText)
  const account = j.account ?? { id: "default", handle: null }
  const workspaces = {}
  for (const w of j.workspaces ?? []) workspaces[w.id] = { name: w.name, role: w.role }
  return { account, workspaces }
}

function printAccountBlock(server, accountId, indent = "  ", showHandle = true) {
  const a = getAccount(server, accountId)
  if (!a) return
  if (showHandle) console.log(`${indent}${a.handle ? `@${a.handle}` : accountId}`)
  const entries = Object.entries(a.workspaces ?? {})
  if (!entries.length) {
    console.log(`${indent}    (no workspaces saved — run derive login --sync)`)
    return
  }
  for (const [id, w] of entries) {
    const mark = id === a.defaultWorkspace ? "●" : " "
    const tag = id === a.defaultWorkspace ? "  (default)" : ""
    console.log(`${indent}  ${mark} ${w.name}   ${w.role}${tag}`)
    if (w.description) console.log(`${indent}      ${w.description}`)
  }
}

/** Refresh `accountId`'s token if needed, re-fetch its workspace roster, and
 *  report what changed (join/rename/removal) since the last sync. Shared by
 *  `derive login --sync` and the manage hub's "re-sync" menu item. */
async function syncWorkspaces(server, accountId) {
  if (!accountId) {
    console.error("error: not signed in — run `derive login` first")
    process.exit(1)
  }
  const token = await freshToken(server, accountId)
  if (!token) {
    console.error("error: that account's session is gone — run `derive login --add`")
    process.exit(1)
  }
  let discovered
  try {
    discovered = await fetchWorkspaces(server, token)
  } catch (e) {
    console.error(`error: couldn't sync: ${e.message}`)
    process.exit(1)
  }
  const diff = setWorkspaces(server, accountId, discovered.workspaces)
  const account = getAccount(server, accountId)
  console.log(`✓ Synced ${account.handle ? `@${account.handle}` : accountId} on ${server}`)
  for (const w of diff.added) console.log(`    + ${w.name}          (joined)`)
  for (const w of diff.renamed) console.log(`    ~ ${w.from} → ${w.to}   (renamed)`)
  for (const w of diff.removed)
    console.log(`    - ${w.name}          (no longer a member, removed locally)`)
  if (!diff.added.length && !diff.renamed.length && !diff.removed.length)
    console.log("    (no changes)")
}

/** The full OAuth round trip: register (or reuse) a client, open the browser,
 *  take the pasted code, exchange it, then discover and save the account's
 *  workspace roster. `flags.workspace`/`flags.pick` narrow which workspaces are
 *  kept locally; the default is all of them. */
async function doOAuthLogin(server, loginFlags) {
  const b64url = (b) =>
    b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
  const redirect = `${server}/oauth/cli-callback`
  // derive:manage (opt-in via --manage) lets `derive context push` mint the
  // answering agent and create the context. Opt-in, not default: it raises a
  // leaked token's blast radius from editor to your full workspace authority,
  // so only sessions that actually manage contexts should carry it.
  const scope =
    loginFlags.scope ??
    `openid offline_access derive:read derive:comment derive:propose derive:publish derive:review${
      loginFlags.manage === "true" ? " derive:manage" : ""
    }`
  const verifier = b64url(randomBytes(64))
  const challenge = b64url(createHash("sha256").update(verifier).digest())
  const state = b64url(randomBytes(16))

  // Reuse this machine's client for this server across logins (including a
  // second --add account), so a workspace picked on the consent screen — bound
  // server-side to (user, client) — actually persists instead of resetting on
  // every fresh registration.
  let clientId = getClientId(server)
  if (!clientId) {
    const reg = await fetch(`${server}/api/auth/oauth2/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: loginFlags.name ?? "Derive CLI",
        redirect_uris: [redirect],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    }).catch((e) => ({ ok: false, status: 0, json: async () => ({ error: e.message }) }))
    const client = await reg.json().catch(() => ({}))
    if (!reg.ok || !client.client_id) {
      console.error(
        `error: client registration failed (${reg.status}): ${client.error ?? "unknown"}`,
      )
      process.exit(1)
    }
    clientId = client.client_id
    saveClientId(server, clientId)
  }

  const authUrl =
    `${server}/api/auth/oauth2/authorize?response_type=code` +
    `&client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirect)}` +
    `&scope=${encodeURIComponent(scope)}` +
    `&code_challenge=${challenge}&code_challenge_method=S256&state=${state}`

  console.log(
    loginFlags.add
      ? `\nOpening ${server} (sign in as the account to add)...`
      : `\nOpening ${server} to authorize (scopes: ${scope}).`,
  )
  console.log(`If your browser doesn't open, visit:\n\n  ${authUrl}\n`)
  openBrowser(authUrl)

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
      client_id: clientId,
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

  let discovered
  try {
    discovered = await fetchWorkspaces(server, tj.access_token)
  } catch (e) {
    console.error(`error: signed in, but couldn't list workspaces: ${e.message}`)
    process.exit(1)
  }
  const accountId = discovered.account.id
  const wasSignedIn = !!getDefault(server)
  // Captured before saveAccount/setWorkspaces touch anything: whether THIS
  // account already had a roster locally, so a --workspace/--pick narrowing
  // below can be told apart from a first-time discovery.
  const existingWorkspaces = getAccount(server, accountId)?.workspaces ?? {}
  saveAccount(server, accountId, {
    handle: discovered.account.handle ?? null,
    grant: {
      token: tj.access_token,
      refresh_token: tj.refresh_token,
      client_id: clientId,
      expires_in: tj.expires_in,
    },
  })

  // Which workspaces to keep locally: one (--workspace), a checklist (--pick),
  // or — the default — every workspace this account belongs to, so a single
  // sign-in is immediately usable everywhere.
  let chosen = discovered.workspaces
  if (loginFlags.workspace) {
    const found = findWorkspaceInMap(discovered.workspaces, loginFlags.workspace)
    if (!found) {
      console.error(`error: no workspace "${loginFlags.workspace}" for this account`)
      process.exit(1)
    }
    chosen = { [found.id]: { name: found.name, role: found.role } }
  } else if (loginFlags.pick) {
    const entries = Object.entries(discovered.workspaces)
    console.log("\nSelect workspaces (comma-separated numbers, or 'a' for all):")
    entries.forEach(([, w], i) => {
      console.log(`  ${i + 1}) ${w.name}  (${w.role})`)
    })
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const answer = await new Promise((resolve) => rl.question("> ", resolve))
    rl.close()
    const picked =
      answer.trim().toLowerCase() === "a"
        ? entries
        : answer
            .split(",")
            .map((s) => Number.parseInt(s.trim(), 10) - 1)
            .filter((i) => i >= 0 && i < entries.length)
            .map((i) => entries[i])
    chosen = Object.fromEntries(picked)
  }
  const narrowing = !!(loginFlags.workspace || loginFlags.pick)
  setWorkspaces(server, accountId, mergeChosenWorkspaces(existingWorkspaces, chosen, narrowing))

  const handleLabel = discovered.account.handle ? `@${discovered.account.handle}` : accountId
  console.log()
  if (!wasSignedIn) {
    console.log(`✓ Signed in to ${server} as ${handleLabel}`)
    const account = getAccount(server, accountId)
    const entries = Object.entries(account.workspaces)
    const all = Object.keys(discovered.workspaces).length === entries.length
    console.log(
      `  Added ${all ? `all ${entries.length}` : entries.length} workspace${entries.length === 1 ? "" : "s"}:`,
    )
    printAccountBlock(server, accountId, "  ", false)
    const def = account.workspaces[account.defaultWorkspace]
    if (def) {
      console.log(`\n  Publishes here target ${def.name}.`)
      console.log(`  Change with:  derive workspace use "<name>"`)
    }
  } else {
    console.log(`✓ Added ${handleLabel} to ${server}`)
    console.log(`  Accounts on ${server}:`)
    for (const a of listAccounts(server)) printAccountBlock(server, a.id, "    ")
    const defaultHandle = listAccounts(server).find((a) => a.isDefault)
    console.log(
      `\n  Default account stays ${defaultHandle?.handle ? `@${defaultHandle.handle}` : "unchanged"}.`,
    )
    console.log(`  Switch with:  derive account use ${handleLabel}`)
  }
}

async function interactiveLogout(server) {
  const accounts = listAccounts(server)
  if (!accounts.length) {
    console.log("Not signed in.")
    return
  }
  const labels = [
    ...accounts.map((a) => `${a.handle ? `@${a.handle}` : a.id}${a.isDefault ? " (default)" : ""}`),
    "All accounts",
    "Cancel",
  ]
  const i = await promptChoice("Sign out which account?", labels)
  if (i === null || i === labels.length - 1) return
  if (i === labels.length - 2) {
    for (const a of accounts) removeAccount(server, a.id)
    console.log(
      `✓ Signed out of ${server}. Cleared ${accounts.length} account${accounts.length === 1 ? "" : "s"} and their workspace maps.`,
    )
    return
  }
  const a = accounts[i]
  removeAccount(server, a.id)
  const remaining = listAccounts(server).find((r) => r.isDefault)
  const stays = remaining
    ? ` ${remaining.handle ? `@${remaining.handle}` : remaining.id} stays; default falls back to it.`
    : ""
  console.log(`✓ Signed out ${a.handle ? `@${a.handle}` : a.id}.${stays}`)
}

/** What `derive login` shows when already signed in: current state, then a
 *  menu (re-sync / switch default workspace / add an account / sign out) — a
 *  second login should never blindly re-authenticate or duplicate an account. */
async function manageHub(server, hubFlags) {
  const def = getDefault(server)
  console.log(`\nSigned in to ${server}`)
  for (const a of listAccounts(server)) printAccountBlock(server, a.id)

  const choice = await promptChoice("\nWhat next?", [
    "Re-sync workspaces from server",
    "Switch default workspace",
    "Add another account",
    "Sign out",
    "Cancel",
  ])
  if (choice === null || choice === 4) return
  if (choice === 0) {
    await syncWorkspaces(
      server,
      hubFlags.account ? resolveAccountRef(server, hubFlags.account) : def.account,
    )
  } else if (choice === 1) {
    const account = getAccount(server, def.account)
    const entries = Object.entries(account.workspaces ?? {})
    if (!entries.length) {
      console.log("No workspaces saved for this account — run `derive login --sync` first.")
      return
    }
    const i = await promptChoice(
      "Default workspace:",
      entries.map(([, w]) => w.name),
    )
    if (i !== null) {
      const [id, w] = entries[i]
      setDefaultWorkspace(server, def.account, id)
      console.log(`✓ Default workspace on ${server} is now ${w.name}.`)
    }
  } else if (choice === 2) {
    await doOAuthLogin(server, { ...hubFlags, add: "true" })
  } else if (choice === 3) {
    await interactiveLogout(server)
  }
}

if (cmd === "login") {
  const server = resolveServer(flags)

  if (flags.sync) {
    const accountId = flags.account
      ? resolveAccountRef(server, flags.account)
      : getDefault(server)?.account
    await syncWorkspaces(server, accountId)
    process.exit(0)
  }

  const existingDefault = getDefault(server)
  if (existingDefault && !flags.add && !flags.workspace && !flags.pick) {
    await manageHub(server, flags)
    process.exit(0)
  }

  await doOAuthLogin(server, flags)
  process.exit(0)
}

// ---- derive accounts / workspaces / workspace / account / logout -----------
if (cmd === "accounts") {
  const server = resolveServer(flags)
  const accounts = listAccounts(server)
  if (flags.json) {
    console.log(
      JSON.stringify(
        accounts.map((a) => ({ ...a, workspaces: getAccount(server, a.id)?.workspaces ?? {} })),
      ),
    )
    process.exit(0)
  }
  if (!accounts.length) {
    console.log(`Not signed in to ${server}. Run \`derive login\`.`)
    process.exit(0)
  }
  console.log(server)
  for (const a of accounts) printAccountBlock(server, a.id)
  const def = getDefault(server)
  const account = def && getAccount(server, def.account)
  const ws = account?.workspaces?.[def?.workspace]
  console.log(
    `\nPublishing here targets:  ${account?.handle ? `@${account.handle}` : def?.account} / ${ws?.name ?? "(no workspace)"}`,
  )
  process.exit(0)
}

if (cmd === "workspaces") {
  const server = resolveServer(flags)
  const accountId = flags.account
    ? resolveAccountRef(server, flags.account)
    : getDefault(server)?.account
  if (!accountId) {
    console.error(`error: not signed in to ${server}`)
    process.exit(1)
  }
  const account = getAccount(server, accountId)
  if (flags.json) {
    console.log(JSON.stringify(account.workspaces))
    process.exit(0)
  }
  console.log(`${server} · ${account.handle ? `@${account.handle}` : accountId}`)
  printAccountBlock(server, accountId, "", false)
  process.exit(0)
}

if (cmd === "workspace") {
  const sub = positional[0]
  const ref = positional[1]
  if (!["use", "forget", "describe"].includes(sub) || !ref) {
    console.error(
      "usage: derive workspace use|forget <name|id> [--account a]\n" +
        '       derive workspace describe <name|id> ["what it\'s for"] [--account a] [--clear]',
    )
    process.exit(1)
  }
  const server = resolveServer(flags)
  const accountId = flags.account
    ? resolveAccountRef(server, flags.account)
    : getDefault(server)?.account
  if (!accountId) {
    console.error(`error: not signed in to ${server}`)
    process.exit(1)
  }
  try {
    if (sub === "use") {
      const w = setDefaultWorkspace(server, accountId, ref)
      console.log(`✓ Default workspace on ${server} is now ${w.name}.`)
    } else if (sub === "forget") {
      const w = forgetWorkspace(server, accountId, ref)
      if (!w) {
        console.error(`error: no workspace "${ref}" for this account`)
        process.exit(1)
      }
      console.log(`✓ Removed ${w.name} from this machine.  Re-add: derive login --sync`)
    } else {
      const text = positional.slice(2).join(" ")
      if (!text && !flags.clear) {
        const found = findAccountWorkspace(server, accountId, ref)
        if (!found) {
          console.error(`error: no workspace "${ref}" for this account`)
          process.exit(1)
        }
        const description = getAccount(server, accountId).workspaces[found.id]?.description
        console.log(description ?? "(no description set — pass text to set one)")
      } else {
        const w = describeWorkspace(server, accountId, ref, flags.clear ? null : text)
        console.log(
          flags.clear ? `✓ Cleared the description for ${w.name}.` : `✓ ${w.name} → "${text}"`,
        )
      }
    }
  } catch (e) {
    console.error(`error: ${e.message}`)
    process.exit(1)
  }
  process.exit(0)
}

if (cmd === "account") {
  const sub = positional[0]
  const ref = positional[1]
  if (sub !== "use" || !ref) {
    console.error("usage: derive account use <@handle|id>")
    process.exit(1)
  }
  const server = resolveServer(flags)
  const accountId = resolveAccountRef(server, ref)
  if (!accountId) {
    console.error(`error: no signed-in account matches "${ref}"`)
    process.exit(1)
  }
  setDefaultAccount(server, accountId)
  const account = getAccount(server, accountId)
  const ws = account.workspaces[account.defaultWorkspace]
  console.log(
    `✓ Default account is now ${account.handle ? `@${account.handle}` : accountId}.  Default workspace: ${ws?.name ?? "(none saved)"}.`,
  )
  process.exit(0)
}

if (cmd === "logout") {
  const server = resolveServer(flags)
  if (flags.all) {
    const accounts = listAccounts(server)
    for (const a of accounts) removeAccount(server, a.id)
    console.log(`✓ Signed out of ${server}.`)
    process.exit(0)
  }
  if (flags.account) {
    const accountId = resolveAccountRef(server, flags.account)
    if (!accountId) {
      console.error(`error: no signed-in account matches "${flags.account}"`)
      process.exit(1)
    }
    const account = getAccount(server, accountId)
    removeAccount(server, accountId)
    const remaining = listAccounts(server).find((r) => r.isDefault)
    const stays = remaining
      ? ` ${remaining.handle ? `@${remaining.handle}` : remaining.id} stays; default falls back to it.`
      : ""
    console.log(`✓ Signed out ${account?.handle ? `@${account.handle}` : accountId}.${stays}`)
    process.exit(0)
  }
  await interactiveLogout(server)
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

// ---- derive context (push / dev) --------------------------------------------
// A context is a directory: MANIFEST.md (the runner's system prompt),
// references/, .mcp.json (the context's tools), .env (stays local, always).
// `push` ships that directory as the context's manifest bundle; the first push
// also mints the answering agent and creates the context, so afterwards a push
// is just a new manifest version — the context's pointer never moves. `dev`
// answers real sessions with the WORKING TREE manifest: edit, save, next
// answer uses it, push when it behaves.
if (cmd === "context") {
  const sub = positional.shift()
  if (!["push", "dev"].includes(sub ?? "")) {
    console.error(`usage:
  derive context push [dir]    publish the context dir (minus .env*); first push wires agent + context
  derive context dev  [dir]    run the answer loop on the working-tree manifest [--mock] [--context ctx_id]`)
    process.exit(1)
  }
  const dir = positional[0] ?? "."
  let cfg = null
  try {
    cfg = loadConfig(dir)
  } catch (e) {
    console.error(`error: ${e.message}`)
    process.exit(1)
  }
  if (!cfg?.context) {
    console.error(
      `error: ${join(dir, CONFIG_FILE)} has no "context" block — scaffold one with \`derive init --template context\``,
    )
    process.exit(1)
  }
  const p = resolvePublish(flags, cfg)
  p.token = flags.token ?? process.env.DERIVE_TOKEN ?? (await freshToken(p.server, p.accountId))
  const target = join(dir, cfg.entry ?? "context")
  const name = cfg.context.name ?? cfg.title ?? "My context"
  const tokenFile = join(dir, ".derive", "agent-token")

  if (sub === "push") {
    if (!p.token) {
      console.error("error: not signed in — run `derive login` first")
      process.exit(1)
    }
    let up
    try {
      // repos/ is the runner's clone workspace — pointer state, never source.
      up = readTarget(target, ["repos"])
    } catch (e) {
      console.error(`error: ${e.message}`)
      process.exit(1)
    }
    const { res, json } = await uploadArtifact(p, up.bytes, up.filename)
    if (!res.ok) {
      console.error(`error (${res.status}): ${json.error ?? res.statusText}`)
      process.exit(1)
    }
    if (!p.id && json.short_id) writeId(dir, json.short_id)
    const shortId = p.id ?? json.short_id
    console.log(`✓ manifest ${shortId} v${json.current_version}`)
    for (const s of up.skipped) console.log(`  · ${s} stayed local (secrets never ship)`)

    try {
      let agentId = cfg.context.agent_id
      if (!agentId) {
        const agent = await createAgent(p.server, p.token, name)
        agentId = agent.id
        const tokPath = saveAgentToken(dir, agent.token)
        writeContextConfig(dir, { agent_id: agentId })
        console.log(
          `✓ agent "${name}" (${agentId}) — token saved to ${tokPath} (shown nowhere else)`,
        )
      }
      let ctxId = cfg.context.id
      if (!ctxId) {
        const created = await createContext(p.server, p.token, {
          name,
          agent_id: agentId,
          manifest_short_id: shortId,
        })
        ctxId = created.id
        writeContextConfig(dir, { id: ctxId })
        console.log(`✓ context "${name}" (${ctxId})`)
      }
      // The manifest's roster is the ask roster — an invite-only manifest means
      // only its owner can open a session.
      if (json.visibility === "private")
        console.log(
          `  invite-only — share the manifest (Share dialog, or --visibility org) so teammates can ask`,
        )
      console.log(
        `\nRun it:\n  derive runner serve ${ctxId} --token-file ${tokenFile} --cwd ${target}\nTune it:\n  derive context dev`,
      )
    } catch (e) {
      console.error(`error: ${e.message}`)
      process.exit(1)
    }
    process.exit(0)
  }

  // dev: the runner, pointed at this working tree.
  const ctxId = flags.context ?? cfg.context.id
  if (!ctxId) {
    console.error(
      "error: no context id — `derive context push` once (it pins context.id), or pass --context",
    )
    process.exit(1)
  }
  const devFlags = {
    ...flags,
    context: ctxId,
    server: p.server,
    cwd: flags.cwd ?? target,
    "manifest-file": flags["manifest-file"] ?? join(target, "MANIFEST.md"),
  }
  if (!flags.token && !flags["token-file"] && existsSync(tokenFile))
    devFlags["token-file"] = tokenFile
  const envFile = join(target, ".env")
  if (!flags["env-file"] && existsSync(envFile)) devFlags["env-file"] = envFile
  const { loadRunnerConfig, serve } = await import("../src/runner.js")
  try {
    const rcfg = loadRunnerConfig(process.env, devFlags)
    await serve(rcfg) // runs until killed
  } catch (e) {
    console.error(`error: ${e.message}`)
    process.exit(1)
  }
}

// ---- Loop verbs (comments / open / reply / resolve / reopen) --------------
const LOOP = [
  "comments",
  "open",
  "pull",
  "reply",
  "resolve",
  "reopen",
  "status",
  "send-back",
  "approve",
]
if (LOOP.includes(cmd)) {
  let cfg = null
  try {
    cfg = loadConfig(".")
  } catch (e) {
    console.error(`error: ${e.message}`)
    process.exit(1)
  }
  const r = resolvePublish(flags, cfg)
  requireNoTargetError(r)
  r.token = flags.token ?? process.env.DERIVE_TOKEN ?? (await freshToken(r.server, r.accountId))
  // `derive open <short_id>` / `derive status <short_id>` / `derive comments
  // <short_id>`: a positional id overrides the repo pin — the fallback an agent
  // runs when a publish reports opened_in_tab:false. (reply/resolve keep their
  // positional for the thread/comment id.)
  if (positional[0] && ["open", "status", "comments", "pull"].includes(cmd)) r.id = positional[0]
  if (!r.id) {
    console.error(`error: no artifact id. Set "id" in ${CONFIG_FILE} (publish once), or pass --id.`)
    process.exit(1)
  }
  const auth = {
    ...(r.token ? { authorization: `Bearer ${r.token}` } : {}),
    ...(r.workspaceId ? { "x-derive-workspace": r.workspaceId } : {}),
  }
  const base = `${r.server}/v1/artifacts/${r.id}`
  const die = async (res) => {
    const j = await res.json().catch(() => ({}))
    console.error(`error (${res.status}): ${j.error ?? res.statusText}`)
    process.exit(1)
  }

  if (cmd === "open") {
    const url = `${r.server}/a/${r.id}`
    console.log(url)
    openBrowser(url)
    process.exit(0)
  }

  if (cmd === "comments") {
    const res = await fetch(`${base}/comments`, { headers: auth })
    if (!res.ok) await die(res)
    console.log(formatComments((await res.json()).comments))
    process.exit(0)
  }

  // Source read-back. For single-file artifacts this is the exact published
  // source; for directory/--spa bundles the server returns the ENTRY FILE only
  // (that's all /content serves). Text goes to stdout (pipe-friendly); --out
  // writes a file and keeps the confirmation on stderr.
  if (cmd === "pull") {
    const res = await fetch(`${base}/content${flags.v ? `?v=${flags.v}` : ""}`, { headers: auth })
    if (!res.ok) await die(res)
    const text = await res.text()
    const v = res.headers.get("x-derive-version")
    if (flags.out) {
      try {
        writeFileSync(flags.out, text)
      } catch (e) {
        console.error(`error: cannot write ${flags.out}: ${e.message}`)
        process.exit(1)
      }
      console.error(`✓ ${flags.out} (${r.id}${v ? ` v${v}` : ""})`)
    } else {
      process.stdout.write(text)
    }
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
  derive init [dir] [--template md|html|slides|site|skill|context] [--title t]
  derive login [--local] [--server url] [--workspace w] [--pick] [--add] [--sync] [--manage]
                                            OAuth sign-in (defaults to https://derive.to);
                                            discovers every workspace you belong to;
                                            --manage adds the agent/context admin grant
  derive accounts [--json]                 every signed-in account + its workspaces
  derive workspaces [--account a] [--json] the resolved account's workspaces
  derive workspace use|forget <ref> [--account a]   set/drop the default workspace
  derive workspace describe <ref> ["text"] [--account a] [--clear]
                                            set/show/clear what a workspace is FOR
  derive account use <ref>                 set the default account
  derive logout [--account a] [--all]      sign out
  derive publish [file|dir] [--id X] [--title t] [--slug s] [--spa] [--message m] [--name "x"] [--visibility v] [--password p] [--server url] [--token t] [--workspace w] [--account a] [--json]
  derive comments [--id X]                 list comment threads
  derive pull [short_id] [--v N] [--out f] print an artifact's source (bundles: entry file only)
  derive open [--id X]                     open the artifact in a browser
  derive reply <thread_id> <message…>      reply in a thread
  derive resolve|reopen <comment_id>       set a thread's state
  derive status [--id X] [--json]          review-round state + open threads (the loop's poll target)
  derive send-back [--id X] [--note m]     (human) return your answers to the waiting agent
  derive approve [--id X] [--note m]       (human) approve — the build go-signal
  derive runner serve|doctor|install       run a context's answer daemon (\`derive runner\` for flags)
  derive context push|dev                  ship a context dir as its manifest / tune it on the working tree`)
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
requireNoTargetError(p)

if (!p.target) {
  console.error(
    `error: nothing to publish. Pass a file/dir, or set "entry" in ${CONFIG_FILE} (run \`derive init\`).`,
  )
  process.exit(1)
}

p.token = flags.token ?? process.env.DERIVE_TOKEN ?? (await freshToken(p.server, p.accountId))
requireSignedIn(p)
let up
try {
  up = readTarget(p.target)
} catch (e) {
  console.error(`error: ${e.message}`)
  process.exit(1)
}
const { res, json } = await uploadArtifact(
  p,
  up.bytes,
  up.filename,
  flags.review ? { request_review: "true" } : {},
)
if (!res.ok) {
  console.error(`error (${res.status}): ${json.error ?? res.statusText}`)
  process.exit(1)
}
// stderr so `--json` stdout stays parseable.
for (const s of up.skipped) console.error(`  · ${s} stayed local (.env files never ship)`)

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
      `  ${json.visibility === "org" ? "workspace-only" : "invite-only"} — pass --visibility public (or use the Share dialog) to widen the audience`,
    )
  if (flags.review)
    console.log(`  ↩ review requested — the human reviews in the app, then Send back`)
  if (savedId) console.log(`  saved id to ${CONFIG_FILE} — future publishes target this artifact`)
  if (p.workspaceName) {
    const who = p.accountHandle ? `@${p.accountHandle}` : p.accountId
    console.log(`  → ${p.server} / ${who} / ${p.workspaceName}`)
  }
}
