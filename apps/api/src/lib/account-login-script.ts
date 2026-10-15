// Runs alone in a short-lived sandbox. The official Codex app-server owns device login.
// Credentials live on tmpfs and travel only in an authenticated HTTPS body. Neither
// provider output nor credentials reach sandbox command logs or saved disks.
export const ACCOUNT_LOGIN_SCRIPT = String.raw`
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statfsSync } from 'node:fs'
import { createInterface } from 'node:readline'

const endpoint = process.env.DERIVE_ACCOUNT_CALLBACK
const token = process.env.DERIVE_TOKEN
const bin = '/home/ortam/derive-account-login/node_modules/.bin/codex'
let home, server, deadline
const call = async (body, method = 'POST') => {
  const response = await fetch(endpoint, {
    method, redirect: 'error', signal: AbortSignal.timeout(20000),
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  })
  if (!response.ok) throw new Error('connection_ended')
  return response.json()
}
let output
try {
  if (statfsSync('/dev/shm').type !== 0x01021994) throw new Error('memory_required')
  home = mkdtempSync('/dev/shm/derive-login-')
  const env = { PATH: process.env.PATH, HOME: home, CODEX_HOME: home }
  const input = await call(null, 'GET')
  if (input.secret) {
    if (input.kind === 'login') writeFileSync(home + '/auth.json', input.secret, { mode: 0o600 })
    else env.CODEX_API_KEY = input.secret
  } else {
    server = spawn(bin, ['app-server', '-c', 'cli_auth_credentials_store="file"'], {
      cwd: home, env, stdio: ['pipe', 'pipe', 'ignore'],
    })
    const requests = new Map()
    let sequence = 0, completed
    const login = new Promise((resolve, reject) => {
      completed = resolve
      deadline = setTimeout(() => reject(new Error('expired')), 480000)
      server.once('error', () => reject(new Error('provider_unavailable')))
      server.once('exit', () => reject(new Error('provider_unavailable')))
    })
    // Register the listener before starting login: completion can precede its response.
    login.catch(() => {})
    createInterface({ input: server.stdout }).on('line', (line) => {
      let message
      try { message = JSON.parse(line) } catch { return }
      if (message.id != null) {
        const request = requests.get(message.id)
        if (request) {
          requests.delete(message.id)
          message.error ? request.reject(new Error('provider_unavailable')) : request.resolve(message.result)
        }
      } else if (message.method === 'account/login/completed') completed(message.params)
    })
    const rpc = (method, params) => new Promise((resolve, reject) => {
      const id = ++sequence
      const timer = setTimeout(() => { requests.delete(id); reject(new Error('provider_unavailable')) }, 45000)
      requests.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value) },
        reject: (error) => { clearTimeout(timer); reject(error) },
      })
      server.stdin.write(JSON.stringify({ id, method, params }) + '\n')
    })
    await rpc('initialize', { clientInfo: { name: 'derive', title: 'Derive', version: '1.0' } })
    server.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n')
    const start = await rpc('account/login/start', { type: 'chatgptDeviceCode' })
    if (start.verificationUrl !== 'https://auth.openai.com/codex/device' ||
        !/^[A-Z0-9-]{4,20}$/.test(start.userCode)) throw new Error('provider_unavailable')
    await call({ phase: 'awaiting', verification_url: start.verificationUrl, user_code: start.userCode })
    const result = await login
    clearTimeout(deadline)
    if (!result.success || result.loginId !== start.loginId) throw new Error('approval_failed')
    server.kill('SIGTERM')
  }
  await call({ phase: 'checking' })
  const checked = await new Promise((resolve, reject) => {
    const probe = spawn(bin, ['exec', '--json', '--ephemeral', '--ignore-user-config',
      '--ignore-rules', '--skip-git-repo-check', '--sandbox', 'read-only', '--model', 'gpt-6-luna',
      '--', 'Reply with exactly CONNECTED. Do not use tools.'], { cwd: home, env, stdio: ['ignore', 'pipe', 'ignore'] })
    let completed = false, answer = '', count = 0
    const timer = setTimeout(() => { probe.kill('SIGKILL'); reject(new Error('check_timed_out')) }, 60000)
    createInterface({ input: probe.stdout }).on('line', (line) => {
      count += line.length
      if (count > 65536) { probe.kill('SIGKILL'); return }
      try {
        const event = JSON.parse(line)
        if (event.type === 'turn.completed') completed = true
        if (event.type === 'item.completed' && event.item?.type === 'agent_message') answer = event.item.text
      } catch {}
    })
    probe.once('error', () => { clearTimeout(timer); reject(new Error('provider_unavailable')) })
    probe.once('exit', (code) => {
      clearTimeout(timer)
      code === 0 && completed && answer.trim() === 'CONNECTED'
        ? resolve(true) : reject(new Error('access_failed'))
    })
  })
  if (checked) output = {
    phase: 'ready', kind: input.kind || 'login',
    secret: input.kind === 'api_key' ? input.secret : readFileSync(home + '/auth.json', 'utf8'),
  }
} catch (error) {
  const known = ['expired', 'approval_failed', 'check_timed_out', 'access_failed', 'memory_required']
  output = { phase: 'failed', reason: known.includes(error.message) ? error.message : 'provider_unavailable' }
} finally {
  clearTimeout(deadline)
  if (server && server.exitCode === null) server.kill('SIGKILL')
  if (home) rmSync(home, { recursive: true, force: true })
}
try { await call(output) } catch { process.exitCode = 1 }
`

export const ACCOUNT_LOGIN_SETUP = [
  "set -eu",
  "mkdir -p /home/ortam/derive-account-login",
  "npm install --prefix /home/ortam/derive-account-login --omit=dev --ignore-scripts --no-audit --no-fund --save-exact @openai/codex@0.162.1",
  "cat > /home/ortam/derive-account-login/connect.mjs <<'DERIVE_ACCOUNT_SCRIPT'",
  ACCOUNT_LOGIN_SCRIPT,
  "DERIVE_ACCOUNT_SCRIPT",
].join("\n")
