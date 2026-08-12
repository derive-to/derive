#!/usr/bin/env bash
set -euo pipefail

# Exercise the release-shaped Compose path with a built image. This is deliberately broader than
# an image boot check: it follows the operator sequence through bootstrap, auth, policy, publish,
# online backup, fresh-volume restore, and restored blob readback.

image=${1:-derive:ci}
port=${2:-18080}

if [[ ! "$port" =~ ^[0-9]+$ ]] || ((port < 1024 || port > 65535)); then
  echo "port must be an integer from 1024 through 65535" >&2
  exit 1
fi
if [[ -z "$image" || "$image" == *[[:space:]]* ]]; then
  echo "image reference must be one non-empty argument" >&2
  exit 1
fi

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
work_dir=$(mktemp -d "${TMPDIR:-/tmp}/derive-selfhost-smoke.XXXXXX")
project="derive-quickstart-smoke-$$"
data_volume="${project}-data"
restored_volume="${project}-restored"
compose_file="$work_dir/compose.yml"
env_file="$work_dir/.env"
backup_dir="$work_dir/backups"
origin="http://127.0.0.1:$port"
email="owner-$$@example.invalid"
password="Quickstart-smoke-$$-password"
secret=$(openssl rand -hex 32)

if [[ ! "$project" =~ ^derive-quickstart-smoke-[0-9]+$ ]]; then
  echo "refusing unsafe Compose project name: $project" >&2
  exit 1
fi

compose=(docker compose --env-file "$env_file" -f "$compose_file")

remove_test_volume() {
  local volume=$1
  local expected=$2
  if ! docker volume inspect "$volume" >/dev/null 2>&1; then
    return
  fi
  local owner
  owner=$(docker volume inspect "$volume" --format '{{index .Labels "com.docker.compose.project"}}')
  if [[ "$volume" != "$expected" || "$owner" != "$project" ]]; then
    echo "refusing to remove unexpected Docker volume $volume (project=$owner)" >&2
    return
  fi
  docker volume rm "$volume" >/dev/null
}

cleanup() {
  local status=$?
  set +e
  if [[ -f "$compose_file" && -f "$env_file" ]]; then
    DERIVE_DATA_VOLUME="$restored_volume" "${compose[@]}" down --remove-orphans >/dev/null 2>&1
    "${compose[@]}" down --remove-orphans >/dev/null 2>&1
  fi
  remove_test_volume "$data_volume" "$data_volume"
  remove_test_volume "$restored_volume" "$restored_volume"
  if [[ -d "$backup_dir" && ! -L "$backup_dir" ]]; then
    docker run --rm --user 0 --entrypoint chown -v "$backup_dir:/target" "$image" \
      -R "$(id -u):$(id -g)" /target >/dev/null 2>&1
  fi
  case "$work_dir" in
    "${TMPDIR:-/tmp}"/derive-selfhost-smoke.*)
      if [[ -d "$work_dir" && ! -L "$work_dir" ]]; then
        find -P "$work_dir" -depth -delete
      fi
      ;;
    *) echo "refusing to remove unexpected smoke directory $work_dir" >&2 ;;
  esac
  exit "$status"
}
trap cleanup EXIT

cp "$repo_root/deploy/compose.yml" "$compose_file"
mkdir -p "$backup_dir"
docker run --rm --user 0 --entrypoint sh -v "$backup_dir:/target" "$image" -c \
  'chown 1000:1000 /target && chmod 0700 /target'

{
  printf 'DERIVE_IMAGE=%s\n' "$image"
  printf 'BASE_URL=%s\n' "$origin"
  printf 'DERIVE_SIGNUP_MODE=invite\n'
  printf 'DERIVE_BIND_ADDRESS=127.0.0.1\n'
  printf 'DERIVE_PORT=%s\n' "$port"
  printf 'DERIVE_AUTH_SECRET=%s\n' "$secret"
  printf 'COMPOSE_PROJECT_NAME=%s\n' "$project"
  printf 'DERIVE_DATA_VOLUME=%s\n' "$data_volume"
} >"$env_file"
chmod 0600 "$env_file"

"${compose[@]}" config --quiet
if [[ "$image" == *@sha256:* ]]; then
  "${compose[@]}" pull
fi

printf '%s' "$password" | "${compose[@]}" run --rm -T derive \
  bootstrap-operator --email "$email" --name Owner --password-stdin

"${compose[@]}" up -d --wait --wait-timeout 120
container_id=$("${compose[@]}" ps -q derive)
[[ -n "$container_id" ]]
[[ $(docker inspect "$container_id" --format '{{.State.Health.Status}}') == healthy ]]
[[ $(docker inspect "$container_id" --format '{{.Config.User}}') == node ]]
[[ $(docker inspect "$container_id" --format '{{json .HostConfig.SecurityOpt}}') == *no-new-privileges* ]]
[[ $(docker port "$container_id" 8080/tcp) == "127.0.0.1:$port" ]]

artifact_id=$(env \
  DERIVE_SMOKE_ORIGIN="$origin" \
  DERIVE_SMOKE_EMAIL="$email" \
  DERIVE_SMOKE_PASSWORD="$password" \
  node "$repo_root/scripts/selfhost-smoke-client.mjs" publish)

"${compose[@]}" run --rm derive backup /backups/quickstart-smoke
"${compose[@]}" run --rm derive verify-backup /backups/quickstart-smoke
grep -q '"path": "blobs/' "$backup_dir/quickstart-smoke/derive-backup.json"

"${compose[@]}" down
docker volume inspect "$data_volume" >/dev/null
DERIVE_DATA_VOLUME="$restored_volume" "${compose[@]}" run --rm derive \
  restore-backup /backups/quickstart-smoke
DERIVE_DATA_VOLUME="$restored_volume" "${compose[@]}" up -d --wait --wait-timeout 120
docker volume inspect "$data_volume" >/dev/null

env \
  DERIVE_SMOKE_ORIGIN="$origin" \
  DERIVE_SMOKE_EMAIL="$email" \
  DERIVE_SMOKE_PASSWORD="$password" \
  DERIVE_SMOKE_ARTIFACT_ID="$artifact_id" \
  node "$repo_root/scripts/selfhost-smoke-client.mjs" verify

echo "selfhost quick-start smoke: ok — bootstrap, auth, policy, publish, backup, and restore"
