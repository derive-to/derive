# dock-self-host (local / Lite)

Run Dock locally on your machine in one command. This is the Lite tier: SQLite + local
blobs in a Docker volume, everything on one origin. No external services.

For production deployment, see `deploying/dock-node.md` or `deploying/dock-cloudflare.md`.

---

## Start

```bash
docker compose -f deploy/compose.yml up -d
```

Opens at http://localhost:8080. First person to sign up at `/login` becomes the workspace owner.

Or without Compose:

```bash
docker build -f deploy/Dockerfile -t dock .
docker run -d -p 8080:8080 -v dock_data:/data \
  -e DOCK_AUTH_SECRET="$(openssl rand -hex 32)" \
  -e BASE_URL="http://localhost:8080" \
  dock
```

State lives in the `dock_data` Docker volume. Back it up and you've backed up the instance.

---

## Put it on the internet

Set `BASE_URL` to your real `https://` domain before exposing it publicly — it signs
cookies and builds share links.

Caddy (automatic TLS):

```caddyfile
dock.example.com {
  reverse_proxy localhost:8080
}
```

Then set `BASE_URL=https://dock.example.com` and redeploy.

---

## Key env vars

| Var | What it does |
|---|---|
| `BASE_URL` | Public URL (cookies + share links). Required for internet-facing deploys. |
| `DOCK_AUTH_SECRET` | Session signing key. Generate: `openssl rand -hex 32`. Set it or logins break on restart. |
| `PORT` | Listen port, default 8080. |

---

## Get a DOCK_TOKEN (for MCP + CLI)

1. Sign in at your local instance
2. Settings > Agents > New Agent
3. Name it, copy the `dk_agt_...` token (shown once)

See `using/dock-connect.md` to wire it into Claude Code or Claude Desktop.

---

## Health checks

```bash
curl http://localhost:8080/healthz   # { ok: true }
curl http://localhost:8080/readyz    # { ok: true }
```
