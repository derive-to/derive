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

Use comments and later versions when they help. Formal approval is available for work that
needs a named decision; it is not required for every artifact.

```bash
derive status                 # review state and open threads
derive comments               # full comment threads
derive reply <thread-id> "Updated the evidence and conclusion."
derive publish --name "Revision 2"
derive send-back --note "Good to go — ship it"
```

The Send back note is the human's answer — a note that reads "good to go" IS the
go-signal. An agent publishes directly only at a role that permits it; otherwise it
suggests the change in a comment for a person to apply.

## Connect a project to agents

```bash
derive agent setup
```

This installs Derive's skill in the native Codex and Claude project locations and
adds their project MCP configuration. Run `derive agent setup --update` to refresh the
packaged Derive skill without replacing your MCP configuration.

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

The CLI also manages accounts and workspaces, pulls artifact source, scaffolds skills
and contexts, and runs context workers. `derive --help` is the current command index;
the [Derive documentation](https://docs.derive.to/)
explains the surrounding workflows.

Derive is licensed under FSL-1.1-ALv2 and converts to Apache-2.0 on the schedule in
the [license](https://github.com/derive-to/derive/blob/main/LICENSE).
