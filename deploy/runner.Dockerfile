# The context runner, containerized — owner-operated compute in a box. The
# container boundary IS the sandbox: the model runs headless with permissions
# skipped inside, so the walls are the image contents, the mounted context dir,
# and the env you hand it. Derive-the-company still holds no keys.
#
# Config is purely environment (12-factor): DERIVE_SERVER / DERIVE_CONTEXT /
# DERIVE_TOKEN, RUNNER_MODEL / RUNNER_TIMEOUT_MS / RUNNER_POLL_MS, the selected
# provider's per-run credential, GH_TOKEN (private repo pointers + gh), plus whatever
# the context's .mcp.json expects. The API resolves that credential from the requester,
# an explicitly lending agent owner, or the workspace pool; no model key is baked in.
# See runner.compose.example.yml.
FROM node:24-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03

# git: repo pointers clone at boot. python3 + gh: what context manifests most
# commonly shell out to (doctor checks both, warn-only). uv: the launcher
# python MCP servers ship with (`uvx <server>` in .mcp.json) — the Analytics
# dress rehearsal found the Snowflake MCP dead in the water without it.
ARG UV_VERSION=0.12.4
ARG UV_AMD64_SHA256=c8c60f47e6f88d18dbf6f33d7279fb1fbf7ae76631768152cf5578c3d65729b4
ARG UV_ARM64_SHA256=49d881b3403187e1f1789720881e77e4251ad4259d86c4844862657d2a35d13f
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git python3 \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/* \
    && case "$TARGETARCH" in \
         amd64) uv_arch=x86_64; uv_digest="$UV_AMD64_SHA256" ;; \
         arm64) uv_arch=aarch64; uv_digest="$UV_ARM64_SHA256" ;; \
         *) exit 1 ;; \
       esac \
    && uv_asset="uv-${uv_arch}-unknown-linux-gnu.tar.gz" \
    && curl -fsSLO "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${uv_asset}" \
    && printf '%s  %s\n' "$uv_digest" "$uv_asset" | sha256sum --check --strict \
    && tar -xzf "$uv_asset" --strip-components=1 -C /usr/local/bin \
       "uv-${uv_arch}-unknown-linux-gnu/uv" "uv-${uv_arch}-unknown-linux-gnu/uvx" \
    && rm "$uv_asset"

# Claude Code and the verified Codex CLI from npm; the Derive CLI from THIS checkout, so the image always runs
# the runner that shipped with the repo that built it — no npm-publish lag.
ARG CLAUDE_CODE_VERSION=2.1.232
ARG CODEX_VERSION=0.147.0
RUN npm install -g \
      @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
      @openai/codex@${CODEX_VERSION}
COPY packages/cli /opt/derive-cli
# Global-install of a directory symlinks it without installing its deps —
# install them in place first.
RUN cd /opt/derive-cli && npm install --omit=dev && npm install -g /opt/derive-cli

# Non-root: the container is the boundary, but the model still runs with
# --dangerously-skip-permissions inside it — no reason for that to be root.
# The cache dirs are pre-created OWNED BY runner so compose named volumes
# mounted there inherit that ownership — a volume on a nonexistent mountpoint
# initializes root-owned, npx/uvx die on EACCES the instant they spawn, and
# every MCP server silently never comes up (found the hard way on the first
# Hetzner cutover).
RUN useradd -m runner && mkdir -p /work && chown runner:runner /work \
    && mkdir -p /home/runner/.npm /home/runner/.cache/uv \
    && chown -R runner:runner /home/runner/.npm /home/runner/.cache
COPY --chmod=755 deploy/runner-entrypoint.sh /usr/local/bin/runner-entrypoint.sh
USER runner

# Trust the mounted context's .mcp.json. Interactively, Claude Code asks before
# using a project's MCP servers and remembers the answer in $HOME — a fresh
# container HOME means headless runs silently skip every server (the model sees
# no tools and escalates everything). Mounting a context dir at /work IS the
# approval decision here; the container is the trust boundary.
RUN mkdir -p /home/runner/.claude \
    && printf '{"enableAllProjectMcpServers": true}\n' > /home/runner/.claude/settings.json

# /work is the context directory. Mount the cloned context project's context/
# dir here (compose example) so .mcp.json, references/, and the repos/ clone
# cache travel by git + volume, never by image rebuild. Unmounted also works:
# the manifest and repo pointers still arrive from the server — the context
# just has no local .mcp.json tools.
WORKDIR /work
ENV RUNNER_CWD=/work
# Coding agents run without interactive approvals only because this job container is the outer
# sandbox. Owner-operated node runners do not inherit this flag and keep Codex workspace-scoped.
ENV DERIVE_RUNNER_ISOLATED=1

# Cloudflare's local Containers runtime requires at least one declared port even for a
# one-shot job container. This is image metadata only: RunContainer starts the process directly,
# never waits for a port, and no route or listener exposes the job to traffic.
EXPOSE 8080

ENTRYPOINT ["runner-entrypoint.sh"]
# `docker compose run --rm <svc> doctor` preflights the exact same image + env.
CMD ["serve"]
