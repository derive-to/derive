#!/usr/bin/env node
// Run the local Derive server behind a public HTTPS tunnel, so a real chat host (ChatGPT,
// Claude) can connect to it as a custom MCP connector: `pnpm dev:tunnel`.
//
// What makes this worth having over a deploy: the server runs `tsx watch`, and
// DERIVE_MCP_APP_DEV=1 makes `show` open a stub that loads the CURRENT view from this server
// on every open (apps/api/src/mcp-app-view.ts devViewStub). Edit the view or the server, open
// a new card, see the edit. No deploy, no "Refresh tools", no re-adding the connector, unless
// the tools themselves change.
//
// Tunnel: a cloudflared quick tunnel by default (a new trycloudflare.com URL each run, so the
// connector is re-added once per session). For a URL that never changes, set up a named
// tunnel once (`cloudflared tunnel create derive-dev`, then route a hostname to it) and run
// with DERIVE_TUNNEL_NAME=derive-dev DERIVE_TUNNEL_HOSTNAME=derive-dev.example.com.
//
// Data lives in the server's usual ./data. Sign in on the tunnel URL with email + password
// (the first account you create there); the connector's OAuth sign-in uses the same account.

import { spawn, spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const port = process.env.PORT ?? "8090"
const name = process.env.DERIVE_TUNNEL_NAME
const hostname = process.env.DERIVE_TUNNEL_HOSTNAME

if (spawnSync("cloudflared", ["--version"], { stdio: "ignore" }).status !== 0) {
  console.error("dev:tunnel needs cloudflared: brew install cloudflared")
  process.exit(1)
}

// The OAuth sign-in and consent pages are the web app's, served by this same process once built.
const web = join(root, "apps/web/dist/client")
if (!["index.html", "_shell.html"].some((f) => existsSync(join(web, f)))) {
  console.log("Building the web app once (its sign-in and consent pages serve the OAuth flow)…")
  const built = spawnSync("pnpm", ["--filter", "@derive/web", "build"], {
    cwd: root,
    stdio: "inherit",
  })
  if (built.status !== 0) process.exit(built.status ?? 1)
}

const children = []
const stop = () => {
  for (const c of children) c.kill("SIGTERM")
  process.exit(0)
}
process.on("SIGINT", stop)
process.on("SIGTERM", stop)

const startServer = (url) => {
  const server = spawn("pnpm", ["--filter", "@derive/api", "dev"], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, PORT: port, BASE_URL: url, DERIVE_MCP_APP_DEV: "1" },
  })
  children.push(server)
  server.on("exit", (code) => {
    console.error(`The server exited (${code}).`)
    stop()
  })
  console.log(
    [
      "",
      `  Derive (dev) at ${url}`,
      `  Connector URL:  ${url}/mcp`,
      "",
      "  1. Open the URL above and create an account (email + password), once.",
      "  2. ChatGPT: Settings > Apps > Create (developer mode); Claude: Settings > Connectors >",
      "     Add custom connector. Paste the connector URL and sign in with that account.",
      "  3. Edit the view or the server; open a new card to see it. Refresh the connector's",
      "     tools only when a tool's name, description or parameters change.",
      "",
    ].join("\n"),
  )
}

const args = name
  ? ["tunnel", "--no-autoupdate", "run", "--url", `http://127.0.0.1:${port}`, name]
  : ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`]
if (name && !hostname) {
  console.error("DERIVE_TUNNEL_NAME needs DERIVE_TUNNEL_HOSTNAME (the hostname routed to it).")
  process.exit(1)
}
const tunnel = spawn("cloudflared", args, { stdio: ["ignore", "pipe", "pipe"] })
children.push(tunnel)
tunnel.on("exit", (code) => {
  console.error(`cloudflared exited (${code}).`)
  stop()
})
if (hostname) startServer(`https://${hostname}`)
else {
  let started = false
  const watch = (chunk) => {
    const url = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(String(chunk))?.[0]
    if (url && !started) {
      started = true
      startServer(url)
    }
  }
  tunnel.stdout.on("data", watch)
  tunnel.stderr.on("data", watch)
}
