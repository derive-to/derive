# The context runner, containerized — owner-operated compute in a box. The
# container boundary IS the sandbox: the model runs headless with permissions
# skipped inside, so the walls are the image contents, the mounted context dir,
# and the env you hand it. Derive-the-company still holds no keys.
#
# Config is purely environment (12-factor): DERIVE_SERVER / DERIVE_CONTEXT /
# DERIVE_TOKEN, RUNNER_MODEL / RUNNER_TIMEOUT_MS / RUNNER_POLL_MS, the model
# credential — exactly one of ANTHROPIC_API_KEY (API billing) or
# CLAUDE_CODE_OAUTH_TOKEN (`claude setup-token`, bills the subscription; the
# API key wins if both are set) — GH_TOKEN (private repo pointers + gh), plus
# whatever the context's .mcp.json expects. See runner.compose.example.yml.
FROM node:24-slim

# git: repo pointers clone at boot. python3 + gh: what context manifests most
# commonly shell out to (doctor checks both, warn-only). uv: the launcher
# python MCP servers ship with (`uvx <server>` in .mcp.json) — the Analytics
# dress rehearsal found the Snowflake MCP dead in the water without it.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git python3 \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/* \
    && curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh

# Claude Code from npm (pin via build arg when reproducibility matters more
# than freshness); the Derive CLI from THIS checkout, so the image always runs
# the runner that shipped with the repo that built it — no npm-publish lag.
ARG CLAUDE_CODE_VERSION=latest
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}
COPY packages/cli /opt/derive-cli
# Global-install of a directory symlinks it without installing its deps —
# install them in place first.
RUN cd /opt/derive-cli && npm install --omit=dev && npm install -g /opt/derive-cli

# Non-root: the container is the boundary, but the model still runs with
# --dangerously-skip-permissions inside it — no reason for that to be root.
RUN useradd -m runner && mkdir -p /work && chown runner:runner /work
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

ENTRYPOINT ["runner-entrypoint.sh"]
# `docker compose run --rm <svc> doctor` preflights the exact same image + env.
CMD ["serve"]
