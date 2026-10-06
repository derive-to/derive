// `derive secrets`: save a value as a Derive secret without it passing through a chat, and
// optionally bind it to an agent's environment. The value comes from stdin or a hidden prompt.

/** The rule the server applies to environment variable names (contextEnvironmentNameError). */
export const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/

async function call(client, path, init = {}) {
  const res = await client.fetch(`${client.server}${path}`, {
    ...init,
    headers: {
      ...client.headers,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`)
  return body
}

/**
 * Save `value` as a secret named `name`. Unless `fresh`, the server hands back a secret the
 * caller already saved with the same value and scope instead of storing a second copy.
 * @returns {Promise<{ id: string, name: string, reused: boolean }>}
 */
export async function putSecret(client, { name, value, workspace = false, fresh = false }) {
  const saved = await call(client, "/v1/connections", {
    method: "POST",
    body: JSON.stringify({
      kind: "secret",
      toolkit: "environment",
      scope: workspace ? "workspace" : "personal",
      scopes_label: name,
      secret: value,
      reuse: !fresh,
    }),
  })
  return { id: saved.id, name: saved.scopes_label ?? name, reused: saved.reused === true }
}

/** Point `variable` in an agent's environment at a secret, keeping its other variables. */
export async function attachSecret(client, { agentId, variable, secretId }) {
  const path = `/v1/agents/${encodeURIComponent(agentId)}`
  const agent = await call(client, path)
  const environment = { ...(agent.environment ?? {}), [variable]: secretId }
  const updated = await call(client, path, {
    method: "PATCH",
    body: JSON.stringify({ environment }),
  })
  return { agent: updated.name ?? agentId }
}

/** The caller's visible secrets: names and ids, never values. */
export async function listSecrets(client) {
  const { items = [] } = await call(client, "/v1/credentials")
  return items.map((s) => ({
    id: s.id,
    name: s.name,
    scope: s.scope,
    status: s.status,
    canUse: s.can_use === true,
  }))
}

/** Read a secret value: all of stdin when piped, else a prompt that does not echo. */
export async function readSecretValue({ stdin = process.stdin, stderr = process.stderr } = {}) {
  if (!stdin.isTTY) {
    let raw = ""
    for await (const chunk of stdin) raw += chunk
    // A file or `echo` ends with one newline that is not part of the value.
    return raw.replace(/\r?\n$/, "")
  }
  stderr.write("Value (input hidden): ")
  return new Promise((resolve, reject) => {
    let value = ""
    stdin.setRawMode(true)
    stdin.setEncoding("utf8")
    const done = (err) => {
      stdin.setRawMode(false)
      stdin.pause()
      stdin.off("data", onData)
      stderr.write("\n")
      err ? reject(err) : resolve(value)
    }
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return done()
        if (ch === "\u0003") return done(new Error("cancelled"))
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1)
        else value += ch
      }
    }
    stdin.on("data", onData)
    stdin.resume()
  })
}
