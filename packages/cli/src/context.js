// First-push server wiring for a Context. Persisted ids make later pushes artifact-only.
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const post = async (server, token, path, body) => {
  const res = await fetch(`${server}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  return { res, json }
}

/** Mint the context's answering agent (role editor — it publishes the charts
 *  its answers link). The raw token comes back exactly once; the caller must
 *  persist it immediately. */
export async function createAgent(server, token, name) {
  const { res, json } = await post(server, token, "/v1/agents", { name, role: "editor" })
  // 401/403: the token lacks the manage grant (derive:manage is opt-in at
  // login) or the user isn't workspace admin. The manifest still pushed; only
  // the one-time wiring is blocked.
  if (res.status === 401 || res.status === 403)
    throw new Error(
      `this token can't manage agents (${res.status}).\n` +
        `  If you're a workspace admin: re-run \`derive login --manage\` (the manage grant is opt-in).\n` +
        `  Otherwise, wire it once in the console:\n` +
        `    1. ${server} → Settings → Agent connections → Add connection ("${name}", role editor); save its token to .derive/agent-token\n` +
        `    2. ${server} → Contexts → New context → pick the connection + this manifest\n` +
        `    3. put the agent id in derive.json (context.agent_id) and the context id in context.id\n` +
        `  After that, every push is just a manifest version — no wiring, no console.`,
    )
  if (res.status === 409)
    throw new Error(
      `an agent named "${name}" already exists — set its id as context.agent_id in derive.json (its token was shown when it was created)`,
    )
  if (!res.ok) throw new Error(`agent creation failed (${res.status}): ${json.error ?? "unknown"}`)
  return { id: json.id, token: json.token }
}

/** Create the context wiring agent → manifest. On a name collision, adopt the
 *  existing context if it already points at this manifest (a lost derive.json
 *  should re-pin, not dead-end). */
export async function createContext(server, token, { name, agent_id, manifest_short_id }) {
  const { res, json } = await post(server, token, "/v1/contexts", {
    name,
    agent_id,
    manifest_short_id,
  })
  if (res.ok) return json
  if (res.status === 401)
    throw new Error(
      `this token can't create Contexts (401) — create it once in the console (${server} → Contexts → New context, connection + manifest ${manifest_short_id}), then set context.id in derive.json`,
    )
  if (res.status === 409) {
    const list = await fetch(`${server}/v1/contexts`, {
      headers: { authorization: `Bearer ${token}` },
    })
    const existing = ((await list.json().catch(() => ({}))).contexts ?? []).find(
      (x) => x.name === name && x.manifest_short_id === manifest_short_id,
    )
    if (existing) return existing
    throw new Error(
      `a Context named "${name}" already exists with a different manifest — rename it in derive.json (context.name) or delete the old Context`,
    )
  }
  throw new Error(`Context creation failed (${res.status}): ${json.error ?? "unknown"}`)
}

/** Persist the agent token where the runner's --token-file expects it: outside
 *  the pushed directory, owner-only, covered by the scaffold's .gitignore. */
export function saveAgentToken(dir, token) {
  const tokDir = join(dir, ".derive")
  mkdirSync(tokDir, { recursive: true })
  const path = join(tokDir, "agent-token")
  writeFileSync(path, `${token}\n`, { mode: 0o600 })
  return path
}
