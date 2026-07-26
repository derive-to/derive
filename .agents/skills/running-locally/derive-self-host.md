# derive-self-host (local / Lite)

Run Derive locally on your machine in one command. This is the Lite tier: SQLite + local
blobs in a Docker volume, everything on one origin. No external services.

For production deployment, see `deploying/derive-node.md` or `deploying/derive-cloudflare.md`.

---

## Start

```bash
docker compose -f deploy/compose.yml up -d
```

Opens at http://localhost:8080. First person to sign up at `/login` becomes the workspace owner.

Or without Compose:

```bash
docker build -f deploy/Dockerfile -t derive .
docker run -d -p 8080:8080 -v derive_data:/data \
  -e DERIVE_AUTH_SECRET="$(openssl rand -hex 32)" \
  -e BASE_URL="http://localhost:8080" \
  derive
```

State lives in the `derive_data` Docker volume. Back it up and you've backed up the instance.

---

## Put it on the internet

Set `BASE_URL` to your real `https://` domain before exposing it publicly — it signs
cookies and builds share links.

Caddy (automatic TLS):

```caddyfile
derive.example.com {
  reverse_proxy localhost:8080
}
```

Then set `BASE_URL=https://derive.example.com` and redeploy.

---

## Key env vars

| Var | What it does |
|---|---|
| `BASE_URL` | Public URL (cookies + share links). Required for internet-facing deploys. |
| `DERIVE_AUTH_SECRET` | Session signing key. Generate: `openssl rand -hex 32`. Set it or logins break on restart. |
| `PORT` | Listen port, default 8080. |

---

## Get a DERIVE_TOKEN (for MCP + CLI)

1. Sign in at your local instance
2. Settings > Agents > New Agent
3. Name it, copy the `dk_agt_...` token (shown once)

See `../derive/references/connect.md` to wire it into Codex or Claude Code.

---

## Health checks

```bash
curl http://localhost:8080/healthz   # { ok: true }
curl http://localhost:8080/readyz    # { ok: true }
```
