# `@derive-to/cli`

The command-line client for [Derive](https://derive.to): publish agent-made work,
read its review state, respond to feedback, and keep revisions at one durable URL.

## Install or run

```bash
npm install --global @derive-to/cli
derive --help

# Or run without a global install
npx -y @derive-to/cli --help
```

Node.js 20 or newer is required.

## Publish a first artifact

```bash
derive login
derive init launch-plan --template md --title "Launch plan"
cd launch-plan
derive publish
```

`derive login` uses browser OAuth and defaults to the hosted service. `derive init`
creates `derive.json` plus the selected starter. The first publish records the artifact
ID locally; later publishes create new versions at the same URL.

You can also publish an existing file or built site directly:

```bash
derive publish report.md --title "Research report"
derive publish dist/ --title "Launch page" --spa
```

## Continue work at the same URL

Use comments and later versions when they help. A review round is there for work that
needs a named look; it is not required for every artifact.

```bash
derive status                 # review state and open threads
derive comments               # full comment threads
derive reply <thread-id> "Updated the evidence and conclusion."
derive publish --name "Revision 2"
derive send-back                # opens the page; Send back is a signed-in browser gesture
```

The Send back note is the human's answer — a note that reads "good to go" IS the
go-signal. An agent publishes directly only at a role that permits it; otherwise it
suggests the change in a comment for a person to apply.

## Connect a project to agents

```bash
derive agent setup
```

This installs Derive's artifact and workflow skills in the native Codex and Claude project
locations and adds their project MCP configuration. Run `derive agent setup --update` to refresh
the packaged skills without replacing your MCP configuration.

## Preview a graph or bounded loop

The workflow skill authors a visible `bundle-manifest` plus a companion
`workflow-definition` fact. Preview explains the likely paths and runs structural/scenario checks
as one step; there is no separate validation gate.

```bash
derive init weekly-brief --template workflow --title "Weekly brief"
cd weekly-brief
derive workflow preview workflow.html
derive workflow preview workflow.html --json
```

A ready preview exits `0`. A preview with blockers exits `1` and names the `WF-*` repairs. Preview
does not execute nodes, call tools, or mutate external systems. It lists the Context sessions that
an explicit run would open; the connected Codex or Claude harness runs the work through those
existing Derive sessions.

## Run one assigned graph from GitHub Actions

`derive workflow run` is a one-shot adapter deliberately exposed as `derive-*.yml`. It does not
accept a caller-authored prompt or standing Derive bearer. In GitHub Actions it requests an OIDC
assertion with the fixed `derive-graph-runner` audience, exchanges the bounded run id and one-time
nonce for a short-lived run capability, and only then fetches the pinned instruction.

The command runs inside a repository-owned Codex environment. That environment must install and
authenticate Codex before this step starts. Derive does not create an agent, select a sandbox,
choose a model provider, or read model credentials. A managed-agent GitHub Action can own that
setup and invoke this command after its environment is ready.

```yaml
name: Derive graph harness
on:
  workflow_dispatch:
    inputs:
      derive_run_id:
        description: Derive workflow run id
        required: true
        type: string
      derive_exchange_nonce:
        description: One-time Derive exchange nonce
        required: true
        type: string

permissions:
  contents: read
  id-token: write

jobs:
  graph:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    steps:
      - name: Check out the repository
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - name: Install the pinned adapter
        run: npm install --global "@derive-to/cli@0.6.0"
      # Your repository or runner provider installs and authenticates Codex.
      - name: Run the assigned graph
        env:
          DERIVE_WORKFLOW_RUN_ID: ${{ inputs.derive_run_id }}
          DERIVE_EXCHANGE_NONCE: ${{ inputs.derive_exchange_nonce }}
        run: derive workflow run
```

GitHub supplies `ACTIONS_ID_TOKEN_REQUEST_URL` and `ACTIONS_ID_TOKEN_REQUEST_TOKEN` when
`id-token: write` is present. The command never prints those values, the nonce, the OIDC assertion,
or the exchanged capability. The command uses the runner's existing Codex identity and limits its
Derive connection to the one-run capability and the `use` tool. Agent provisioning and lifecycle
stay outside Derive and remain the repository workflow's responsibility.

## Hosted and self-hosted servers

The CLI resolves its server from `derive.json`, then `DERIVE_SERVER`, then
`https://derive.to`. Use a flag when you need an explicit target:

```bash
derive login --server https://derive.example.com
derive publish page.html --server https://derive.example.com
```

Interactive use should prefer `derive login`. `DERIVE_TOKEN` and `--token` are
intended for CI, agents, and other headless automation; treat them as credentials and
do not commit them. Anonymous callers are read-only.

## Access on publish

Omitting access flags uses the workspace default, normally a team draft. For an
explicit policy:

```bash
derive publish page.html \
  --workspace-access member \
  --link-role viewer \
  --listed none
```

- `workspace-access`: `none` or `member`
- `link-role`: `none`, `viewer`, `commenter`, or `editor`
- `listed`: `none`, `workspace`, or `public`

Anonymous link holders are always clamped to viewing. A commenter or editor link asks
an unsigned visitor to sign in before writing. See the
[access model](https://docs.derive.to/concepts/access/) for
the complete contract.

## More commands

The CLI also manages accounts and workspaces, pulls artifact source, scaffolds skills and Contexts,
and serves Context sessions. `derive --help` is the current command index;
the [Derive documentation](https://docs.derive.to/)
explains the surrounding workflows.

Published Skills install natively into both Claude and Codex by default:

```sh
derive skill add <short_id>
derive skill sync <short_id> --client codex
derive skill sync --all
derive skill remove <short_id> --scope project
```

Project installs use `.claude/skills` and `.agents/skills`; personal installs use
`~/.claude/skills` and `~/.codex/skills`. Installs are atomic and pinned in `derive.json`.
`sync --all` updates every pinned Skill while preserving any Claude-only or Codex-only installs.

Derive is licensed under FSL-1.1-ALv2 and converts to Apache-2.0 on the schedule in
the [license](https://github.com/derive-to/derive/blob/main/LICENSE).
