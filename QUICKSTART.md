# Quick start: self-host Derive

This guide gets Derive running with one container, SQLite, and local artifact storage.
At the end, you will have:

- a Derive instance listening on `127.0.0.1:8080`;
- an instance operator account created without opening public signup;
- persistent data in a Docker volume; and
- a verified first backup on the host.

## Choose one path

| Goal | Use |
|---|---|
| Run Derive on a server | [Install a published release](#install-a-published-release-recommended) |
| Test `main`, a branch, or a pull request | [Build the current checkout](#build-the-current-checkout) |
| Change Derive code with live reload | [CONTRIBUTING.md](CONTRIBUTING.md#setup) |
| Use Postgres, S3/R2, multiple containers, or Cloudflare | [DEPLOY.md](DEPLOY.md#deployment-tiers) |

Use only one installation procedure. A release is the normal server path because its image is
versioned and pinned by digest. Build from a checkout when you intentionally need unreleased code.

## Requirements

The container supports 64-bit AMD and ARM hosts. Before you start, install:

- Docker Engine with Docker Compose 2.24 or later, or Docker Desktop;
- a Bash-compatible shell;
- `curl`; and
- `openssl` for generating the session-signing secret.

Allow at least 4 GB of free Docker storage to pull and run a published image. Building the
current checkout also keeps build layers and needs at least 10 GB free during the first build.
These figures leave working room beyond the approximately 2.2 GB unpacked runtime image measured
on `linux/amd64`; your database, artifacts, and off-host backups need additional capacity.

Confirm that Docker and Compose are available:

```bash
docker version
docker compose version
```

For an Internet-facing server, you also need a domain name and a TLS-terminating reverse proxy.
Derive binds to loopback by default so it is not exposed before HTTPS is configured.

## Install a published release (recommended)

Use this path when the [latest GitHub release](https://github.com/derive-to/derive/releases/latest)
contains `compose.yml` and `selfhost.env.example`. If those files are not available yet, use
[Build the current checkout](#build-the-current-checkout).

### 1. Download the release configuration

Create a directory for the installation and download the two release files:

```bash
mkdir derive-selfhost
cd derive-selfhost

curl -fsSLO https://github.com/derive-to/derive/releases/latest/download/compose.yml
curl -fsSLO https://github.com/derive-to/derive/releases/latest/download/selfhost.env.example
```

The downloaded environment example pins `DERIVE_IMAGE` to the release's immutable image digest.

### 2. Configure the instance

Copy the example, then generate a session-signing secret:

```bash
cp selfhost.env.example .env

DERIVE_QUICKSTART_SECRET="$(openssl rand -hex 32)"
printf '\nDERIVE_AUTH_SECRET=%s\n' "${DERIVE_QUICKSTART_SECRET:?}" >> .env
unset DERIVE_QUICKSTART_SECRET
```

Open `.env` and set these values:

| Variable | Local evaluation | Internet-facing server |
|---|---|---|
| `BASE_URL` | `http://localhost:8080` | Your public origin, such as `https://derive.example.com` |
| `DERIVE_SIGNUP_MODE` | `invite` | `invite` |
| `DERIVE_BIND_ADDRESS` | `127.0.0.1` | `127.0.0.1` when the proxy runs on this host |

Keep the digest-pinned `DERIVE_IMAGE` from the release file. Do not replace it with `latest` on a
production server.

### 3. Create the host backup directory

On a Linux server, create the directory with the uid and gid used by the non-root container:

```bash
sudo install -d -o 1000 -g 1000 -m 0700 backups
```

On Docker Desktop, create it with `mkdir -p backups`; Docker Desktop manages the host-to-container
file ownership.

### 4. Validate and pull the release

Render the final Compose configuration before changing the host:

```bash
docker compose --env-file .env -f compose.yml config --quiet
docker compose --env-file .env -f compose.yml pull
```

The first command prints nothing when the configuration is valid. The second pulls the exact image
digest recorded in `.env`.

### 5. Create the first operator while the service is offline

Enter a password of 8–128 characters. It is passed through stdin and does not appear in shell
history or the process list:

```bash
read -rsp 'Operator password: ' DERIVE_BOOTSTRAP_PASSWORD
printf '%s' "${DERIVE_BOOTSTRAP_PASSWORD:?}" | docker compose \
  --env-file .env -f compose.yml run --rm -T derive \
  bootstrap-operator --email owner@example.com --name 'Owner' --password-stdin
unset DERIVE_BOOTSTRAP_PASSWORD
```

Replace the email and name before running the command. A successful command prints the new user ID.

### 6. Start Derive and wait for readiness

Start the service in the background and wait for its health check:

```bash
docker compose --env-file .env -f compose.yml up -d --wait --wait-timeout 120
curl -fsS http://127.0.0.1:8080/readyz
```

The readiness response is:

```json
{"ok":true}
```

For a local evaluation, open <http://localhost:8080> and sign in with the operator account.

### 7. Put an Internet-facing instance behind HTTPS

Point your existing reverse proxy at `127.0.0.1:8080`. For example, a minimal Caddy site is:

```caddyfile
derive.example.com {
  reverse_proxy 127.0.0.1:8080
}
```

Confirm that `.env` has the matching `BASE_URL=https://derive.example.com`, restart Derive after
changing it, and then sign in through that HTTPS URL:

```bash
docker compose --env-file .env -f compose.yml up -d --wait --wait-timeout 120
```

### 8. Create and verify the first backup

The backup command takes an online SQLite snapshot, copies local blobs and identity files, and
verifies the completed directory:

```bash
DERIVE_BACKUP="/backups/derive-$(date -u +%Y%m%dT%H%M%SZ)"
docker compose --env-file .env -f compose.yml run --rm derive backup "${DERIVE_BACKUP:?}"
docker compose --env-file .env -f compose.yml run --rm derive verify-backup "${DERIVE_BACKUP:?}"
unset DERIVE_BACKUP
```

Copy the resulting directory from `./backups` to a separate system. A backup stored only beside
the live volume does not protect against losing the host.

## Build the current checkout

Use this path to test unreleased code. The resulting image is called `derive:local`; it is not a
published or attested release image.

### 1. Get the source and create the environment file

Clone the repository, or switch an existing checkout to the branch you want to test:

```bash
git clone https://github.com/derive-to/derive.git
cd derive
cp deploy/selfhost.env.example deploy/.env
```

Open `deploy/.env`. For a local evaluation, set:

```dotenv
BASE_URL=http://localhost:8080
DERIVE_SIGNUP_MODE=invite
DERIVE_BIND_ADDRESS=127.0.0.1
```

Generate and append the session-signing secret:

```bash
DERIVE_QUICKSTART_SECRET="$(openssl rand -hex 32)"
printf '\nDERIVE_AUTH_SECRET=%s\n' "${DERIVE_QUICKSTART_SECRET:?}" >> deploy/.env
unset DERIVE_QUICKSTART_SECRET
```

### 2. Create the backup directory

On a Linux host, create the bind-mounted directory for the non-root container:

```bash
sudo install -d -o 1000 -g 1000 -m 0700 deploy/backups
```

On Docker Desktop, use `mkdir -p deploy/backups`.

### 3. Validate and build the image

The second Compose file replaces the release image with a build of the current checkout:

```bash
docker compose --env-file deploy/.env \
  -f deploy/compose.yml -f deploy/compose.build.yml config --quiet

docker compose --env-file deploy/.env \
  -f deploy/compose.yml -f deploy/compose.build.yml build
```

### 4. Create the first operator

Create the operator before starting the service:

```bash
read -rsp 'Operator password: ' DERIVE_BOOTSTRAP_PASSWORD
printf '%s' "${DERIVE_BOOTSTRAP_PASSWORD:?}" | docker compose \
  --env-file deploy/.env \
  -f deploy/compose.yml -f deploy/compose.build.yml \
  run --rm -T derive \
  bootstrap-operator --email owner@example.com --name 'Owner' --password-stdin
unset DERIVE_BOOTSTRAP_PASSWORD
```

### 5. Start and verify the local build

Start the image and wait until SQLite and the blob store are ready:

```bash
docker compose --env-file deploy/.env \
  -f deploy/compose.yml -f deploy/compose.build.yml \
  up -d --wait --wait-timeout 120

curl -fsS http://127.0.0.1:8080/healthz
curl -fsS http://127.0.0.1:8080/readyz
```

Open <http://localhost:8080> and sign in with the operator account. Then create and verify the
first backup from the source-built image:

```bash
DERIVE_BACKUP="/backups/derive-$(date -u +%Y%m%dT%H%M%SZ)"
docker compose --env-file deploy/.env \
  -f deploy/compose.yml -f deploy/compose.build.yml \
  run --rm derive backup "${DERIVE_BACKUP:?}"
docker compose --env-file deploy/.env \
  -f deploy/compose.yml -f deploy/compose.build.yml \
  run --rm derive verify-backup "${DERIVE_BACKUP:?}"
unset DERIVE_BACKUP
```

## If startup fails

Inspect the rendered configuration, service state, and logs in that order:

```bash
docker compose --env-file .env -f compose.yml config
docker compose --env-file .env -f compose.yml ps
docker compose --env-file .env -f compose.yml logs --tail 200 derive
```

For a source build, use the `deploy/.env`, `deploy/compose.yml`, and
`deploy/compose.build.yml` arguments shown above.

Common causes are an unset `DERIVE_IMAGE`, an unwritable `backups` directory, port 8080 already in
use, or a `BASE_URL` that does not match the URL in the browser.

## Next steps

- Read [DEPLOY.md](DEPLOY.md#backup-restore-and-password-recovery) for scheduled backups, restore,
  password recovery, updates, Postgres/S3 deployments, SSO, Slack, and other optional features.
- Read [CONTRIBUTING.md](CONTRIBUTING.md) if you want the live-reload development stack rather than
  the production container build.
- Keep Internet-facing instances on `DERIVE_SIGNUP_MODE=invite` or `closed`. Existing users can
  still sign in in either mode.
