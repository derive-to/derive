#!/usr/bin/env bash
set -euo pipefail

# Download a public release exactly as a new operator does, compare it with the files that were
# uploaded, then run the normal quick-start smoke against the downloaded copies. A tag release is
# intentionally tested before it is promoted to GitHub/GHCR "latest".

release_selector=${1:-}
expected_image=${2:-}
port=${3:-18080}
staged_dir=${4:-release}
test_scope=${5:-full}
default_download_base=https://github.com/derive-to/derive/releases/download
download_base=${DERIVE_RELEASE_DOWNLOAD_BASE:-$default_download_base}

if [[ "$release_selector" != latest ]] &&
  [[ ! "$release_selector" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.-]+)?$ ]]; then
  echo "release selector must be latest or v-prefixed semver (for example v1.2.3)" >&2
  exit 1
fi
if [[ -z "$expected_image" || "$expected_image" == *[[:space:]]* ]]; then
  echo "expected image reference must be one non-empty argument" >&2
  exit 1
fi
if [[ "$download_base" == "$default_download_base" ]] &&
  [[ ! "$expected_image" =~ ^ghcr\.io/derive-to/derive@sha256:[0-9a-f]{64}$ ]]; then
  echo "published bundles must use an immutable derive GHCR digest" >&2
  exit 1
fi
if [[ ! -d "$staged_dir" || -L "$staged_dir" ]]; then
  echo "staged release directory does not exist or is unsafe: $staged_dir" >&2
  exit 1
fi
if [[ "$test_scope" != full && "$test_scope" != assets-only ]]; then
  echo "test scope must be full or assets-only" >&2
  exit 1
fi

if [[ "$download_base" == "$default_download_base" && "$release_selector" == latest ]]; then
  release_url=https://github.com/derive-to/derive/releases/latest/download
else
  release_url="$download_base/$release_selector"
fi

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
download_dir=$(mktemp -d "${TMPDIR:-/tmp}/derive-release-download.XXXXXX")

cleanup() {
  local status=$?
  case "$download_dir" in
    "${TMPDIR:-/tmp}"/derive-release-download.*)
      if [[ -d "$download_dir" && ! -L "$download_dir" ]]; then
        find -P "$download_dir" -depth -delete
      fi
      ;;
    *) echo "refusing to remove unexpected download directory $download_dir" >&2 ;;
  esac
  exit "$status"
}
trap cleanup EXIT

assets=(compose.yml selfhost.env.example image-digest.txt SHA256SUMS)
for asset in "${assets[@]}"; do
  staged_file="$staged_dir/$asset"
  if [[ ! -f "$staged_file" || -L "$staged_file" ]]; then
    echo "staged release asset does not exist or is unsafe: $staged_file" >&2
    exit 1
  fi

  # -q ignores a runner's curl config. GitHub tokens are deliberately removed: success must prove
  # the release and its assets are available to an anonymous quick-start user.
  env -u GH_TOKEN -u GITHUB_TOKEN curl -q --fail --silent --show-error --location \
    --retry 12 --retry-delay 2 --retry-all-errors \
    --output "$download_dir/$asset" "$release_url/$asset"
  cmp "$staged_file" "$download_dir/$asset"
done

(cd "$download_dir" && sha256sum -c SHA256SUMS)

downloaded_image=$(tr -d '\r\n' <"$download_dir/image-digest.txt")
if [[ "$downloaded_image" != "$expected_image" ]]; then
  echo "published image-digest.txt does not contain the image that was built" >&2
  exit 1
fi

env_image=$(sed -n 's/^DERIVE_IMAGE=//p' "$download_dir/selfhost.env.example")
if [[ "$env_image" != "$expected_image" ]]; then
  echo "published selfhost.env.example does not contain exactly one expected DERIVE_IMAGE" >&2
  exit 1
fi

rendered_image=$(docker compose \
  --env-file "$download_dir/selfhost.env.example" \
  -f "$download_dir/compose.yml" config --images)
if [[ "$rendered_image" != "$expected_image" ]]; then
  echo "published Compose bundle does not render exactly the expected image" >&2
  exit 1
fi

if [[ "$test_scope" == full ]]; then
  "$repo_root/scripts/test-selfhost-quickstart.sh" \
    "$expected_image" "$port" \
    "$download_dir/compose.yml" "$download_dir/selfhost.env.example"
fi

echo "published self-host bundle: ok — anonymous download, exact assets, and $test_scope test"
