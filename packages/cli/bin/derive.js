#!/usr/bin/env node
// derive — scaffold, publish, and continue work against a Derive server.
//   derive init [dir] [--template md|html|workflow|slides|site|skill|context] [--title t]
//   derive onboard [dir] [--update]       add/update artifact-first instructions + agent setup
//   derive agent setup [dir] [--update]   install/update Codex/Claude skills + MCP config
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
//   derive publish [file|dir] [--id --title --slug --spa --message --tags a,b --name --workspace-access --link-role --listed --password --server --token --workspace --account]  (--visibility is a deprecated shorthand)
//   derive tag                             the workspace tag vocabulary (tag → count)
//   derive tag --suggest [--id]            suggest tags for the artifact (from similar docs)
//   derive tag <tag…> [--rm a,b] [--set a,b] [--id]  add/remove/replace an artifact's tags
//   derive delete [short_id…] [--yes]      permanently delete (asks for the id back; no undo)
//   derive comments [--id]                 list the artifact's comment threads
//   derive pull [short_id] [--v N] [--out f]  print an artifact's source (bundles: entry file)
//   derive open [short_id] [--id]          open the artifact in a browser
//   derive reply <thread_id> <message…>    reply in a thread
//   derive resolve|reopen <comment_id>     set a thread's state
//   derive status [--id] [--json]          the review round state + open threads
//   derive send-back [--id] [--note m]     open the page to send your answers back (a browser gesture)
//   derive doctor [--server url] [--token t]  report which optional features are configured
//   derive runner serve|once|doctor|install   run a context's answer daemon, or drain once (npx-able anywhere)
//   derive context push|dev                ship a context dir as its manifest / tune it live
//   derive workflow preview [file] [--json] explain + validate a graph/loop before it runs
import { spawn } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
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
  scaffoldAgent,
  setDefaultAccount,
  setDefaultWorkspace,
  setWorkspaces,
  TEMPLATES,
  writeContextConfig,
  writeId,
  writeSkillPin,
} from "../src/config.js"
import { createAgent, createContext, saveAgentToken } from "../src/context.js"
import { readTarget, uploadArtifact } from "../src/publish.js"
import { DeriveClient, parseManifest } from "../src/runner.js"
import { materializeNotes, materializeSkills, pinManifestSkills } from "../src/skills.js"
import { formatWorkflowPreview, previewWorkflowSource } from "../src/workflow.js"

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
  else if (a === "--suggest") flags.suggest = "true"
  else if (a === "--update") flags.update = "true"
  // Boolean, so it must be listed here: the catch-all below would otherwise eat the next
  // argument as its value, and `derive delete abc --yes` would silently not be confirmed.
  else if (a === "--yes") flags.yes = "true"
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
  const meta = [CONFIG_FILE, "derive.schema.json", "AGENTS.md", "CLAUDE.md", ".gitignore"]
  const entry = created.find((f) => !meta.includes(f) && !f.startsWith(".")) ?? "the entry"
  const next =
    template === "context"
      ? "derive context push"
      : template === "workflow"
        ? "derive workflow preview workflow.html"
        : "derive publish"
  console.log(
    created.length
      ? `\nReady (${template}). Edit ${entry}, then run \`${next}\`.`
      : `\nNothing to do — ${CONFIG_FILE} already here.`,
  )
  process.exit(0)
}

if (cmd === "onboard" || (cmd === "agent" && positional[0] === "setup")) {
  const dir = cmd === "onboard" ? (positional[0] ?? ".") : (positional[1] ?? ".")
  const { created, updated, outdated, skipped } = scaffoldAgent(dir, {
    update: flags.update === "true",
  })
  for (const f of created) console.log(`  + ${f}`)
  for (const f of updated) console.log(`  ~ ${f} (updated)`)
  for (const f of outdated) console.log(`  ! ${f} (differs, kept)`)
  for (const f of skipped) console.log(`  · ${f} (exists, kept)`)
  if (outdated.length)
    console.log(
      "\nA managed Derive instruction or packaged skill differs. Run `derive onboard --update` to refresh only Derive-owned blocks and skill files; project prose and MCP configs remain untouched.",
    )
  const keptConfigs = skipped.filter(
    (file) => file === ".mcp.json" || file === ".codex/config.toml",
  )
  if (keptConfigs.length)
    console.log(
      `\nExisting ${keptConfigs.join(" and ")} kept. Ensure each one has a "derive" server pointing to https://derive.to/mcp.`,
    )
  console.log(
    created.length || updated.length
      ? "\nDerive onboarding installed. Restart your agent, trust the project MCP config, and complete OAuth when prompted."
      : outdated.length
        ? "\nAgent on-ramp is present; update available."
        : "\nNothing to do — the agent on-ramp is already current.",
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
    `openid offline_access derive:read derive:comment derive:publish${
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

// ---- doctor: which optional features are configured on a running instance ----
if (cmd === "doctor") {
  const server = resolveServer(flags)
  const accountId = flags.account
    ? resolveAccountRef(server, flags.account)
    : getDefault(server)?.account
  const token =
    flags.token ??
    process.env.DERIVE_TOKEN ??
    (accountId ? await freshToken(server, accountId) : null)
  if (!token) {
    console.error(
      "error: derive doctor needs operator auth — run `derive login`, or pass --token / set DERIVE_TOKEN.",
    )
    process.exit(1)
  }
  const res = await fetch(`${server}/v1/system/capabilities`, {
    headers: { authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    const j = await res.json().catch(() => ({}))
    console.error(`error (${res.status}): ${j.error ?? res.statusText}`)
    process.exit(1)
  }
  const { capabilities } = await res.json()
  const icon = { on: "✓", off: "·", partial: "⚠" }
  console.log(`Derive @ ${server}\n`)
  let partial = 0
  for (const cap of capabilities) {
    if (cap.status === "partial") partial++
    const head = `${icon[cap.status] ?? "?"}  ${cap.label}`
    console.log(cap.status === "partial" ? `${head} — missing ${cap.missing.join(", ")}` : head)
  }
  console.log(
    partial
      ? `\n${partial} feature(s) half-configured. Set the missing vars, or unset the rest.`
      : "\nAll good — no half-configured features.",
  )
  process.exit(partial ? 1 : 0)
}

// ---- derive runner (serve / doctor / install) -------------------------------
// The context runner as a CLI verb: `derive runner serve <ctx>` on any machine
// with Node. Config: flags win over env (DERIVE_SERVER/TOKEN/CONTEXT, RUNNER_*);
// --token-file keeps the secret out of service-unit command lines; --env-file
// loads a context's own secrets (KEY=VALUE) before anything reads them.
if (cmd === "runner") {
  const sub = positional.shift()
  if (!["serve", "once", "run", "doctor", "install"].includes(sub ?? "")) {
    console.error(`usage:
  derive runner serve  [ctx_id] [--server url] [--token t | --token-file f] [--env-file f]
                       [--cwd dir] [--claude-bin path] [--model m] [--poll ms] [--timeout ms] [--mock]
  derive runner once   [same flags]        drain the queue once and exit — for schedulers (cron, Actions)
  derive runner run    [token] [--server url] [--cwd dir] [--model m] [--timeout ms] [--mock]
                                           execute ONE dispatched automation run (per-run capability
                                           token; the hosted substrate entrypoint) and exit
  derive runner doctor [same flags]        preflight: server, token+context, manifest, cwd, claude, gh, python3
  derive runner install [same flags]       print a launchd/systemd unit for this config`)
    process.exit(1)
  }
  const { doctor, loadRunnerConfig, once, renderServiceUnit, runOnce, serve } = await import(
    "../src/runner.js"
  )
  if (sub === "run") {
    // The hosted one-shot: no context, no poll loop. The bearer is a per-run capability token
    // (dkrun_…) minted at dispatch; partial config because there is no context id to require.
    if (positional[0]) flags.token = positional[0]
    let rcfg
    try {
      rcfg = loadRunnerConfig(process.env, flags, { partial: true })
    } catch (e) {
      console.error(`error: ${e.message}`)
      process.exit(1)
    }
    if (!rcfg.token || !rcfg.server) {
      console.error(
        "error: runner run needs a capability token (positional/--token/DERIVE_TOKEN) and a server (--server/DERIVE_SERVER)",
      )
      process.exit(1)
    }
    // A fresh scratch cwd per run unless the substrate mounts one: hosted runs must never
    // share a working directory across runs.
    if (!flags.cwd) rcfg = { ...rcfg, cwd: mkdtempSync(join(tmpdir(), "derive-run-")) }
    try {
      const counts = await runOnce(rcfg)
      process.exit(counts.failed > 0 ? 1 : 0)
    } catch (e) {
      console.error(`error: ${e.message}`)
      process.exit(1)
    }
  }
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
    if (sub === "once") {
      // Per-session failures are recorded server-side (fail()) and are not a
      // reason to retry the drain — the same input fails the same way until the
      // asker follows up. Only boot/queue errors reach the catch and exit 1,
      // which is the scheduler's signal to retry with backoff.
      await once(rcfg)
      process.exit(0)
    }
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
    // Lockfile step: pin any unpinned `skills:` entry to its current version before the
    // manifest ships, so the pushed config is deterministic and an upgrade is a visible,
    // deliberate manifest edit (never a silent drift under a permission-skipping runner).
    const manifestPath = join(target, "MANIFEST.md")
    if (existsSync(manifestPath)) {
      const text = readFileSync(manifestPath, "utf8")
      const unpinned = parseManifest(text).skills.filter((s) => s.version == null)
      if (unpinned.length) {
        const versions = new Map()
        for (const s of unpinned) {
          try {
            const detail = await (
              await fetch(`${p.server}/v1/artifacts/${s.id}`, {
                headers: { authorization: `Bearer ${p.token}` },
              })
            ).json()
            if (Number.isFinite(detail?.current_version)) versions.set(s.id, detail.current_version)
          } catch {
            /* leave unpinned — the runner fetches current and logs it unpinned */
          }
        }
        const { text: pinnedText, pinned } = pinManifestSkills(text, versions)
        if (pinned.length) {
          writeFileSync(manifestPath, pinnedText)
          for (const pn of pinned) console.log(`  · pinned skill ${pn.id} → v${pn.version}`)
        }
      }
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
      // The manifest's roster is the ask roster — an invite-only manifest (no
      // workspace access) means only its owner can open a session.
      if (json.workspace_access === "none")
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
  // Findability: one `tag` verb — vocabulary (no args), suggest (--suggest), or apply.
  "tag",
  // Permanent delete, mirroring `organize` state:'deleted'. Ids come positionally, so it
  // must also be exempt from the repo-pin requirement below.
  "delete",
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
  // `derive tag` with NO tags + NO --suggest is the workspace vocabulary — needs no artifact
  // id; every other loop verb (and the apply/suggest forms of `tag`) does.
  const tagVocab =
    cmd === "tag" &&
    positional.length === 0 &&
    !flags.rm &&
    flags.set === undefined &&
    !flags.suggest
  // `delete` names its targets positionally (and can take several), so a repo pin is not
  // required when ids were given — unlike the single-artifact loop verbs above.
  const positionalTargets = cmd === "delete" && positional.length > 0
  if (!r.id && !tagVocab && !positionalTargets) {
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

  // ---- Findability: one `derive tag` verb, mirroring the MCP `organize` tool -----
  //   derive tag                       → the workspace tag vocabulary
  //   derive tag --suggest [--id]      → tag suggestions for the artifact
  //   derive tag <tag…> [--rm a,b] [--set a,b] [--id]  → add / remove / replace
  if (cmd === "tag") {
    const splitTags = (v) =>
      String(v ?? "")
        .split(/[,\s]+/)
        .map((t) => t.trim())
        .filter(Boolean)

    // No tags + no --suggest → the workspace vocabulary (no artifact id needed).
    if (tagVocab) {
      const res = await fetch(`${r.server}/v1/tags`, { headers: auth })
      if (!res.ok) await die(res)
      const tags = ((await res.json()).tags ?? []).sort(
        (a, b) => b.count - a.count || a.tag.localeCompare(b.tag),
      )
      if (flags.json) console.log(JSON.stringify(tags))
      else if (tags.length === 0) console.log("(no tags yet)")
      else {
        const w = Math.max(...tags.map((t) => t.tag.length))
        for (const t of tags) console.log(`  ${t.tag.padEnd(w)}  ${t.count}`)
      }
      process.exit(0)
    }

    if (flags.suggest) {
      const res = await fetch(`${base}/tag-suggestions`, { headers: auth })
      if (!res.ok) await die(res)
      const s = await res.json()
      if (flags.json) {
        console.log(JSON.stringify(s))
      } else {
        console.log(`current:    ${s.current.length ? s.current.join(", ") : "(none)"}`)
        console.log(
          `suggested:  ${s.suggested.length ? s.suggested.map((x) => x.tag).join(", ") : "(none — no similar docs)"}`,
        )
        console.log(
          `vocabulary: ${
            s.vocabulary.length
              ? s.vocabulary
                  .slice(0, 20)
                  .map((x) => x.tag)
                  .join(", ")
              : "(empty)"
          }`,
        )
        if (s.suggested.length)
          console.error(`\n  apply:  derive tag ${s.suggested.map((x) => x.tag).join(" ")}`)
      }
      process.exit(0)
    }

    // Apply: positional tokens add; `--rm` removes; `--set` replaces the whole set.
    const add = positional
    const remove = splitTags(flags.rm)
    const set = flags.set !== undefined ? splitTags(flags.set) : null
    const put = async (tags) => {
      const res = await fetch(`${base}/tags`, {
        method: "PUT",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ tags }),
      })
      if (!res.ok) await die(res)
      return (await res.json()).tags
    }
    let tags
    if (set !== null) {
      tags = await put(set)
    } else {
      // Read-modify-write the single artifact: union in `add`, drop `remove`.
      const cur = await fetch(base, { headers: auth })
      if (!cur.ok) await die(cur)
      const existing = (await cur.json()).tags ?? []
      const removeSet = new Set(remove.map((t) => t.toLowerCase()))
      tags = await put([...existing, ...add].filter((t) => !removeSet.has(t.toLowerCase())))
    }
    if (flags.json) console.log(JSON.stringify({ id: r.id, tags }))
    else console.log(`✓ ${r.id} tags: ${tags.length ? tags.join(", ") : "(none)"}`)
    process.exit(0)
  }

  // ---- Permanent delete, mirroring `organize` state:'deleted' ----------------------
  //   derive delete [short_id…] [--yes] [--json]
  //
  // Asks for the id back rather than a y/n. This is the one command here with nothing
  // behind it, and a reflex "y" is exactly the input that should not be enough. `--yes`
  // is the script path, where a prompt would only hang; without a TTY and without --yes
  // it refuses rather than deleting unattended.
  if (cmd === "delete") {
    const ids = positional.length ? positional : r.id ? [r.id] : []
    if (!ids.length) {
      console.error(`error: no artifact id. Pass one (derive delete <short_id>), or --id.`)
      process.exit(1)
    }
    if (!flags.yes) {
      if (!process.stdin.isTTY) {
        console.error("error: refusing to delete without a terminal. Pass --yes to confirm.")
        process.exit(1)
      }
      const phrase = ids.length === 1 ? ids[0] : "delete"
      console.error(
        `About to PERMANENTLY delete ${ids.length} artifact(s), with every version and comment:\n  ${ids.join("\n  ")}\nThis cannot be undone.`,
      )
      const rl = createInterface({ input: process.stdin, output: process.stdout })
      const typed = await new Promise((resolve) =>
        rl.question(`Type ${phrase} to confirm: `, resolve),
      )
      rl.close()
      if ((typed ?? "").trim() !== phrase) {
        console.error("aborted — nothing was deleted.")
        process.exit(1)
      }
    }
    const results = []
    for (const id of ids) {
      const res = await fetch(`${r.server}/v1/artifacts/${id}`, { method: "DELETE", headers: auth })
      results.push({ id, ok: res.ok, status: res.status })
      if (!res.ok && ids.length === 1) await die(res)
    }
    const okCount = results.filter((x) => x.ok).length
    if (flags.json) console.log(JSON.stringify({ command: "delete", results }))
    else {
      for (const x of results)
        console.log(`${x.ok ? "✓" : "✗"} ${x.id}${x.ok ? "" : ` (${x.status})`}`)
      console.log(`${okCount} deleted permanently.`)
    }
    process.exit(okCount === ids.length ? 0 : 1)
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

  if (cmd === "send-back") {
    const res = await fetch(`${base}/review/send-back`, {
      method: "POST",
      headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify({ note: flags.note ?? "" }),
    })
    if (res.status === 403) {
      // Settling a round is recorded as a person's decision, and only a signed-in
      // browser session proves a person — a CLI credential acts FOR you, so the
      // server refuses it here. Hand the human the page where the gesture lives.
      const url = `${r.server}/a/${r.id}`
      console.error("Send back records a human decision, so it needs your signed-in browser.")
      console.error(`Opening ${url} — use the Send back box in the comments sidebar.`)
      openBrowser(url)
      process.exit(1)
    }
    if (!res.ok) await die(res)
    const { round } = await res.json()
    console.log(`✓ sent back to the agent (round ${round.state})`)
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

// ---- derive skill (add) -----------------------------------------------------
// The consumption half of the skill loop: author with `init --template skill` +
// `publish`, then INSTALL a published skill into ./.claude/skills/<name>/ where
// this project's agent auto-discovers it. Pinned in derive.json so an update is a
// deliberate `derive skill add` re-run, never silent drift.
if (cmd === "skill") {
  const sub = positional.shift()
  const shortId = positional[0]
  if (sub !== "add" || !shortId) {
    console.error("usage: derive skill add <short_id>   materialize a skill into ./.claude/skills/")
    process.exit(cmd ? 1 : 0)
  }
  let cfg = null
  try {
    cfg = loadConfig(".")
  } catch {
    /* no derive.json yet — the pin creates one */
  }
  const r = resolvePublish(flags, cfg)
  r.token = flags.token ?? process.env.DERIVE_TOKEN ?? (await freshToken(r.server, r.accountId))
  if (!r.token) {
    console.error("error: not signed in — run `derive login` first")
    process.exit(1)
  }
  const auth = {
    authorization: `Bearer ${r.token}`,
    ...(r.workspaceId ? { "x-derive-workspace": r.workspaceId } : {}),
  }
  const detail = await (await fetch(`${r.server}/v1/artifacts/${shortId}`, { headers: auth }))
    .json()
    .catch(() => null)
  if (!detail?.current_version) {
    console.error(`error: no such artifact ${shortId}`)
    process.exit(1)
  }
  if (!detail.bundle?.isSkill) {
    console.error(`error: ${shortId} is not a skill (a bundle with a SKILL.md)`)
    process.exit(1)
  }
  const version = detail.current_version
  const api = new DeriveClient(r.server, r.token).skillApi()
  const cat = await materializeSkills(
    api,
    [{ id: shortId, version }],
    join(".", ".claude", "skills"),
  )
  const done = cat.find((s) => s.ok)
  if (!done) {
    console.error("error: could not materialize the skill")
    process.exit(1)
  }
  writeSkillPin(".", { id: shortId, version, name: done.name })
  console.log(`✓ .claude/skills/${done.dir} — ${done.name} @v${version} (pinned in ${CONFIG_FILE})`)
  process.exit(0)
}

// ---- derive brandprint (pull) -----------------------------------------------
// Take the team's whole Brandprint into THIS repo in one command: skills into
// .claude/skills/, prose notes into ./brandprint/. The workspace layer plus the
// signed-in user's personal layer (profile wins), resolved the same way the server
// does for a connected agent — but landed on disk for any repo, not just a runner.
if (cmd === "brandprint") {
  const sub = positional.shift()
  if (sub !== "pull") {
    console.error(
      "usage: derive brandprint pull   materialize the workspace + your Brandprint here",
    )
    process.exit(cmd ? 1 : 0)
  }
  let cfg = null
  try {
    cfg = loadConfig(".")
  } catch {
    /* no derive.json — fine, we only read */
  }
  const r = resolvePublish(flags, cfg)
  r.token = flags.token ?? process.env.DERIVE_TOKEN ?? (await freshToken(r.server, r.accountId))
  if (!r.token) {
    console.error("error: not signed in — run `derive login` first")
    process.exit(1)
  }
  const auth = {
    authorization: `Bearer ${r.token}`,
    ...(r.workspaceId ? { "x-derive-workspace": r.workspaceId } : {}),
  }
  const getJson = async (path) =>
    (await fetch(`${r.server}${path}`, { headers: auth })).json().catch(() => null)
  // Resolve both layers' collection ids (workspace base, personal on top).
  const ws = await getJson("/v1/workspace/settings")
  const me = await getJson("/v1/me")
  const collectionIds = [
    ...new Set([ws?.brandprint?.collectionId, me?.brandprint?.collectionId].filter(Boolean)),
  ]
  if (collectionIds.length === 0) {
    console.error("no Brandprint set on this workspace or your profile — nothing to pull")
    process.exit(0)
  }
  // Gather members across the collections, deduped, split skills vs notes.
  const seen = new Set()
  const skills = []
  const notes = []
  for (const id of collectionIds) {
    // limit=100 is the endpoint's max; a curated Brandprint is far smaller, but cap
    // explicitly rather than inherit the default 30 and silently drop members.
    const page = await getJson(`/v1/artifacts?collection=${id}&limit=100`)
    for (const a of page?.artifacts ?? []) {
      if (seen.has(a.short_id)) continue
      seen.add(a.short_id)
      if (a.current_content_type === "derive/skill")
        skills.push({ id: a.short_id, version: a.current_version })
      else notes.push({ short_id: a.short_id, title: a.title, version: a.current_version })
    }
  }
  const api = new DeriveClient(r.server, r.token).skillApi()
  const skillCat = await materializeSkills(api, skills, join(".", ".claude", "skills"))
  const noteCat = await materializeNotes(api, notes, join(".", "brandprint"))
  const okSkills = skillCat.filter((s) => s.ok).length
  const okNotes = noteCat.filter((n) => n.ok).length
  console.log(
    `✓ pulled ${okSkills} skill${okSkills === 1 ? "" : "s"} into .claude/skills/ and ` +
      `${okNotes} note${okNotes === 1 ? "" : "s"} into brandprint/`,
  )
  process.exit(0)
}

if (cmd === "workflow") {
  const action = positional[0]
  if (action !== "preview") {
    console.error("usage: derive workflow preview [file] [--json]")
    process.exit(1)
  }
  let config = null
  try {
    config = loadConfig(".")
  } catch (e) {
    console.error(`error: ${e.message}`)
    process.exit(1)
  }
  const target = positional[1] ?? config?.entry ?? (existsSync("index.html") ? "index.html" : null)
  if (!target) {
    console.error(
      `error: no workflow file. Pass one, set "entry" in ${CONFIG_FILE}, or add index.html.`,
    )
    process.exit(1)
  }
  let source
  try {
    source = readFileSync(target, "utf8")
  } catch (e) {
    console.error(`error: couldn't read ${target}: ${e.message}`)
    process.exit(1)
  }
  const preview = previewWorkflowSource(source)
  console.log(flags.json ? JSON.stringify(preview) : formatWorkflowPreview(preview))
  process.exit(preview.status === "ready" ? 0 : 1)
}

if (cmd !== "publish") {
  console.error(`usage:
  derive init [dir] [--template md|html|workflow|slides|site|skill|context] [--title t]
  derive onboard [dir] [--update]         prefer Derive in AGENTS.md + CLAUDE.md; install skills + MCP config
  derive agent setup [dir] [--update]     compatibility alias for derive onboard
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
  derive publish [file|dir] [--id X] [--title t] [--slug s] [--spa] [--message m] [--name "x"]
                 [--workspace-access none|member] [--link-role none|viewer|commenter|editor]
                 [--listed none|workspace|public] [--password p]
                 [--server url] [--token t] [--workspace w] [--account a] [--json]
                 (access omitted ⇒ the workspace default — the "team draft".
                  --visibility public|org|private is a deprecated shorthand.)
  derive comments [--id X]                 list comment threads
  derive pull [short_id] [--v N] [--out f] print an artifact's source (bundles: entry file only)
  derive open [--id X]                     open the artifact in a browser
  derive reply <thread_id> <message…>      reply in a thread
  derive resolve|reopen <comment_id>       set a thread's state
  derive status [--id X] [--json]          review-round state + open threads (the loop's poll target)
  derive send-back [--id X] [--note m]     open the page to send your answers back (a browser gesture)
  derive runner serve|doctor|install       run a context's answer daemon (\`derive runner\` for flags)
  derive context push|dev                  ship a context dir as its manifest / tune it on the working tree
  derive workflow preview [file] [--json]  explain + validate a graph/loop before it runs
  derive skill add <short_id>              materialize a published skill into ./.claude/skills/ (pinned)
  derive brandprint pull                   materialize the workspace + your Brandprint into this repo`)
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
const { res, json } = await uploadArtifact(p, up.bytes, up.filename, {
  ...(flags.review ? { request_review: "true" } : {}),
  // --tags a,b sets the artifact's browse tags at publish time (JSON array; the server
  // normalizes). Passed through the form escape hatch so no new UploadTarget field is needed.
  ...(flags.tags
    ? {
        tags: JSON.stringify(
          String(flags.tags)
            .split(/[,\s]+/)
            .map((t) => t.trim())
            .filter(Boolean),
        ),
      }
    : {}),
})
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

// A successful project-scoped publish is the other onboarding entry point: older
// projects may predate `derive init`'s agent package. The installer is idempotent,
// preserves project prose/config, and only appends Derive's marked preference block.
if (config) {
  const onboarded = scaffoldAgent(".")
  const changed = [...onboarded.created, ...onboarded.updated]
  if (changed.length)
    console.error(
      `  + Derive agent onboarding (${changed.length} files); restart the agent to load it`,
    )
  if (onboarded.outdated.length)
    console.error("  ! Derive agent files differ; run `derive onboard --update` to refresh them")
}

// `--json`: print the server response only, for scripts + CI (the GitHub Action
// parses this). Otherwise the friendly summary.
if (flags.json) {
  console.log(JSON.stringify(json))
} else {
  console.log(`✓ ${json.url}`)
  // The server returns the v2 access triple (workspace_access/link_role/listed);
  // fold it into one human label for the summary line.
  const world = json.link_role && json.link_role !== "none"
  const access = world
    ? `link: ${json.link_role}`
    : json.workspace_access === "member"
      ? "workspace"
      : "invite-only"
  console.log(`  short_id ${json.short_id} · v${json.current_version} · ${json.kind} · ${access}`)
  // A publish has no world link by default, so a mailed URL 404s for an outside
  // recipient; say so, so nobody shares a link that dead-ends.
  if (!world)
    console.log(
      `  ${json.workspace_access === "member" ? "workspace-only" : "invite-only"} — pass --visibility public (or use the Share dialog) to widen the audience`,
    )
  if (flags.review)
    console.log(`  ↩ review requested — the human reviews in the app, then Send back`)
  if (savedId) console.log(`  saved id to ${CONFIG_FILE} — future publishes target this artifact`)
  if (p.workspaceName) {
    const who = p.accountHandle ? `@${p.accountHandle}` : p.accountId
    console.log(`  → ${p.server} / ${who} / ${p.workspaceName}`)
  }
}
