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
creates `derive.json` plus the selected starter. Templates: `md`, `html`, `workflow`,
`slides`, `site`, `skill`, and two papers, `siggraph` (acmart) and `cvpr`
(the CVPR author kit's layout; add its `cvpr.sty` and `ieeenat_fullname.bst` next to
`paper/main.tex` before compiling). `derive publish` zips the `paper/` folder and Derive
renders `main.tex` as a page. The first publish records the artifact
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

This installs Derive's skill in the native Codex and Claude project
locations and adds their project MCP configuration. Run `derive agent setup --update` to refresh
the packaged skills without replacing your MCP configuration.

## Run an agent on this machine

An agent whose machine is `owner` works on a computer you choose. Its page in Derive, and the
MCP `agents` tool that creates it, give you the one command to start it:

```bash
DERIVE_TOKEN=dk_agt_... npx -y @derive-to/cli runner serve --agent ag_... --server https://derive.to
```

The runner polls for the agent's jobs, does each one in `--cwd` (default: the current directory)
with the agent's instructions and model account, and reports the result. `runner once --agent`
drains the queue once and exits, for a scheduler. `--mock` checks the wiring without a model.
The key rides the environment rather than a flag, so it stays out of the process list, and the
runner never passes it on to the model.

## Run a graph or bounded loop

`derive init --template workflow` starts a page that holds both the visible graph
(`bundle-manifest`) and the runnable `workflow-definition`, joined by the same node IDs:

```bash
derive init weekly-brief --template workflow --title "Weekly brief"
cd weekly-brief
derive publish
```

To run it, make the published page an agent's instructions and ask that agent. Derive walks the
graph as one job: each step becomes a job for the agent it names, and a human step waits for an
answer. The MCP `derive://skills/workflows` skill covers authoring and running one.

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

The CLI also manages accounts and workspaces, pulls artifact source, scaffolds skills, and runs
agents. `derive --help` is the current command index;
the [Derive documentation](https://docs.derive.to/)
explains the surrounding workflows.

Published Skills install natively into both Claude and Codex by default:

```sh
derive skill add <short_id>
derive skill sync <short_id> --client codex
derive skill sync --all
derive skill used <short_id> --client codex
derive skill used <short_id> --client codex --event <event_id> --useful yes
derive skill scan --dry-run --since 30d
derive skill scan --since 30d
derive skill scan setup
derive skill scan setup --schedule
derive skill scan status
derive skill remove <short_id> --scope project
```

The generic scanner records privacy-safe Derive activity from local Codex and Claude logs:

```sh
derive scan --dry-run --since 30d
derive scan --since 30d
derive scan setup
derive scan setup --schedule
derive scan status
derive scan status --all --json
```

`derive scan` records successful artifact reads and publishes with the exact artifact version. It
also runs the installed Skill usage scan. It uploads artifact IDs, versions, operations, clients,
evidence types, opaque session hashes, and event times. It does not upload prompts, responses,
tool arguments, artifact content, file paths, repository paths, raw session IDs, or user names.
The first scan starts at the end of each existing log. Pass `--since 30d` only when you want an
explicit backfill. The scanner writes each receipt to a retry-safe spool before it advances a log
cursor. It checks a small cursor fingerprint before each append scan. If a log was replaced or
truncated and regrown, it safely replays the file through the idempotent receipt API. Pending tool
calls stay separate by client, session, and source.

If a log file cannot be read, scan continues with healthy files and preserves the failed cursor.
The command exits with an error. `derive scan status` shows the affected paths and error codes.
JSON output includes `source_errors`. These local diagnostics are not uploaded. Retry after the
file becomes readable. Dry runs report the same errors without changing saved state.

Unreadable scan state or an artifact spool stops the scan before it advances a cursor. The scanner preserves
the spool for recovery. It rejects explicit failed tool results, unrelated integration tools,
and invalid version values instead of recording them as successful artifact activity.
Named orchestration results and Derive code-mode reads are supported. Mixed code-mode results
that include search or other tools are skipped because they do not prove an artifact was read.

Scans hold a process lock while they update their queue and upload receipts. If another scan owns
the same queue, the command exits with code 75. JSON output includes `code: "scan_in_progress"`.
Retry after the active scan finishes. Normal exits release the lock. After a forced termination,
the lock becomes recoverable after two minutes without a heartbeat. Setup uses the same locks,
so it cannot reset a cursor while a scan uploads receipts. Repeated setup preserves existing
cursors. Setup repairs old three-second session hooks to allow five minutes for a scan.
`setup --dry-run` fails before it changes hooks or state; use `scan --dry-run` to preview receipts.
Status and dry-run commands remain available during an active scan. They do not change local
queues, cursors, or the install registry. Skill dry runs also resolve legacy project pins in memory.

Status shows pending artifact IDs, versions, actions, clients, event times, and retry reasons.
`artifact_unavailable` means the selected account could not resolve the artifact in its available
workspaces. `awaiting_upload` means the receipt has no recorded unavailable result yet. Status shows
20 receipts by default; `--all` includes the whole pending queue. It omits account and session IDs.

The scanner checks every workspace available to the selected account before it rejects an artifact
as unavailable. It keeps unresolved receipts in the local spool. A later scan can resolve them after
an account switch on the original server. Changing servers never retargets pending receipts. The scanner sends no artifact content while it resolves the target.

The artifact page can show another artifact published later in the same opaque session. This is an
observed sequence, not provenance. Derive does not create a run, attach the artifact to a node, or
mark work complete from a scan.

Project installs use `.claude/skills` and `.agents/skills`; personal installs use
`~/.claude/skills` and `~/.codex/skills`. Installs are atomic and pinned in `derive.json`.
`sync --all` updates every pinned Skill while preserving any Claude-only or Codex-only installs.

Run `skill used` after a local agent invokes a pinned Skill. Derive generates an event ID unless
the caller supplies one. Reuse an event ID to add or change its usefulness rating without adding
another use. Derive stores the signed-in user, workspace, pinned version, client, and time on the
server. The Skill page shows aggregate counts. It does not store prompts or generated content.

`skill scan` remains a compatible, Skill-only command. It reads structured local Codex and Claude
logs. It reads only records added after its
saved cursor. Claude provides an explicit Skill attribution. For Codex, the scanner detects a
structured tool call that reads a known installed `SKILL.md`. The scanner uploads the Skill ID,
version, digest, client, evidence type, an opaque session hash, and the event time. It does not
upload prompts, responses, tool arguments, file contents, repository paths, or user names.

Run `skill scan --dry-run --since 30d` before the first backfill. `skill scan setup` installs an
asynchronous session-end command hook for Codex and Claude. The hook does not call an LLM. Add
`--schedule` to install a 30-minute launchd, systemd, or Windows Task Scheduler fallback. Failed
uploads stay in a local spool and retry on the next scan.

Derive is licensed under FSL-1.1-ALv2 and converts to Apache-2.0 on the schedule in
the [license](https://github.com/derive-to/derive/blob/main/LICENSE).
