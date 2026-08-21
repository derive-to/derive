<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/wordmark-on-dark.png">
    <img alt="Derive" src="docs/assets/readme/wordmark-on-light.png" width="200">
  </picture>
</p>

<h1 align="center">Publish, review, and own your AI artifacts.</h1>

<p align="center">
One durable URL for every version, comment, revision, and decision. Your team reviews the work; any compatible agent can act on the feedback. Hosted, or one self-hosted container.
</p>

<p align="center">
  <a href="https://derive.to"><b>Try free</b></a>
  &nbsp;·&nbsp;
  <a href="https://docs.derive.to/self-hosting/quickstart/">Self-host</a>
  &nbsp;·&nbsp;
  <a href="https://docs.derive.to">Docs</a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-FSL--1.1--ALv2-blue" alt="License: FSL-1.1-ALv2"></a>
  <a href="https://www.npmjs.com/package/@derive-to/cli"><img src="https://img.shields.io/npm/v/@derive-to/cli?label=%40derive-to%2Fcli&color=6b46ff" alt="npm @derive-to/cli"></a>
  <a href="https://www.npmjs.com/package/@derive-to/mcp"><img src="https://img.shields.io/npm/v/@derive-to/mcp?label=%40derive-to%2Fmcp&color=6b46ff" alt="npm @derive-to/mcp"></a>
</p>

<p align="center">
  <img src="docs/assets/readme/hero.png" alt="The Derive library: published artifacts with live previews" width="900">
</p>

## Try it now

No account or install is needed. One request publishes a live page:

```bash
curl -F file=@page.html https://derive.to/v1/drafts   # or a .zip of a whole site
# → a live URL, plus a claim link that turns the draft into a
#   permanent, versioned artifact in your workspace
```

Give your agent a durable place to publish, find, and improve work:

```bash
npx skills add derive-to/derive --skill derive        # any agent that reads skills
claude mcp add --transport http derive https://derive.to/mcp   # or connect over MCP
```

Or paste this into a compatible coding agent and let it set itself up:

```text
I'd like you to set up Derive: where the work we make gets published, reviewed, and kept.

Install the skill if I have npm: npx skills add derive-to/derive --skill derive
Otherwise, read https://derive.to/skill.md and follow it (MCP server: https://derive.to/mcp).

Then pick a plan, report, or designed page we've worked on recently and publish it. If I'm not connected to Derive, use the anonymous draft flow. It needs no account and returns a live URL with a claim link. Send me both links.
```

## What is Derive

Derive is a workspace for work made with agents. Give an HTML page, Markdown document, deck,
or built site a lasting URL and version history. Publish from the browser, CLI, HTTP API, or
a compatible agent over MCP. Keep the work private or share it, leave comments, edit it directly,
and publish the next version at the same URL.

The content, version history, and comments stay with each artifact. A teammate or another agent
can open the same URL and see what changed without reconstructing the work from a chat.

A workspace can also run **contexts**: agents that answer questions from connected data and
publish cited results to the same library. Their results use the same URLs, versions, comments,
and access controls as other artifacts.

Derive is Fair Source and self-hostable. Run it as one container on your own infrastructure or
use the hosted app.

## Features

<table>
<tr>
<td width="52%" valign="top">
  <img src="docs/assets/readme/feature-publish.png" alt="A published artifact rendered at its permanent URL" width="100%">
</td>
<td valign="top">

### Publish anything, get a permanent URL

HTML, Markdown, or a whole built site. Every revision is a new version at the same URL, so a link you shared last week still resolves, and still shows its history.

</td>
</tr>
</table>

<table>
<tr>
<td valign="top">

### Comments and changes stay with the work

Share an artifact and @mention the people or agents who should weigh in. Comments pin to the exact text, direct edits create new versions, and connected agents can read feedback and publish focused revisions. When a decision truly needs sign-off, request a formal review of that version.

</td>
<td width="52%" valign="top">
  <img src="docs/assets/readme/feature-review.png" alt="An artifact with its comment and review panel open" width="100%">
</td>
</tr>
</table>

<table>
<tr>
<td width="52%" valign="top">
  <img src="docs/assets/readme/hero.png" alt="The Derive library: every published artifact with a live preview" width="100%">
</td>
<td valign="top">

### A library for published work

Every artifact lands in a library with a live preview. Pin the work you use often, find work
shared with you, and organize related artifacts in collections.

</td>
</tr>
</table>

Also included:

- **Portable context.** Content, versions, and comments stay with the artifact so another person
  or agent can continue the work.
- **Contexts.** Ask an agent questions about connected data and publish cited answers with the
  workspace's access controls.
- **Checkpoints.** Save the state of ongoing work in a page that a later session can open.
- **Sandboxed viewer.** Artifacts run on an opaque origin, isolated from cookies and other artifacts.
- **Flexible storage.** Use SQLite and local disk, or Postgres and S3/R2 at scale.
- **Live collaboration.** Comments, optional approvals, and presence update over Server-Sent Events.
- **Share previews.** Links show an artifact preview in Slack, Discord, X, and Notion.
- **CLI and MCP.** Publish from the terminal or connect a compatible agent.
- **Access controls.** Make work private, visible to the workspace, or public. Public links can
  also use a password.

## Roadmap

The current roadmap lives at **[derive.to/roadmap](https://derive.to/roadmap)** and keeps its
history at the same URL.

## Get started

<a id="get-started"></a>

<table>
<tr>
<td width="50%" valign="top">

### Hosted

The fastest path. No install.

1. Go to [derive.to](https://derive.to)
2. Create an account
3. Publish your first artifact

You get a library, in-browser publishing, version history, and comments.

</td>
<td width="50%" valign="top">

### Self-host

One container is the whole product: API, web, sign-in, publishing, comments, and the
sandboxed viewer, with SQLite and blobs in one volume.

Follow the
**[self-hosting quick start](https://docs.derive.to/self-hosting/quickstart/)** to install a
digest-pinned release or build the current checkout. It includes secure first-user bootstrap,
readiness checks, and a verified first backup. See the
[deployment guide](https://docs.derive.to/self-hosting/configuration/) for Postgres, S3/R2, and
cloud hosts.

</td>
</tr>
</table>

Want a complete artifact rather than a blank starter? Open or publish one of the
**[official examples](https://derive.to/examples)**: a designed launch page, a research brief,
or a living status report. Each shows a different starting point.

### From the terminal

```bash
npm i -g @derive-to/cli
derive init my-doc --template slides   # templates: md · html · slides
cd my-doc
derive publish                         # versioned URL; the id is saved to derive.json
```

### Connect your coding agent (MCP)

[![Add to Cursor](https://cursor.com/deeplink/mcp-install-dark.png)](https://cursor.com/install-mcp?name=derive&config=eyJ1cmwiOiJodHRwczovL2Rlcml2ZS50by9tY3AifQ%3D%3D)
&nbsp;or one line for Claude Code: `claude mcp add --transport http derive https://derive.to/mcp`

```bash
# Derive is a remote MCP server (OAuth). Connect either client:
claude mcp add --transport http --scope project derive https://derive.to/mcp
codex mcp add derive --url https://derive.to/mcp

# or run a local stdio server (set DERIVE_SERVER; DERIVE_TOKEN for a static bearer):
npx -y @derive-to/mcp
```

The agent acts at the role you grant. Publish access publishes directly, as a kept and restorable version with the workspace notified; a lower scope suggests changes in comments for a person to apply. Full setup and tool guidance is in
[packages/mcp/SKILL.md](packages/mcp/SKILL.md).

## How it works

One Node container is the whole product; storage is pluggable behind interfaces. The same image self-hosts on SQLite and local disk, scales on Postgres and S3/R2, or runs on Cloudflare Workers.

```
apps/api          HTTP API, sandboxed artifact serving, viewer
apps/web          web UI (TanStack Start, SPA mode, static bundle)
packages/core     domain: ports, publish, markdown render, viewer shell
packages/db       MetaStore: sqlite (default) · postgres · d1
packages/storage  BlobStore: fs (default) · s3/r2
packages/cli      derive init (md/html/slides) · derive publish <file|dir> · derive runner serve (host a context)
packages/mcp      Local compatibility MCP: eight agent tools + derive://guide
```

Every artifact ships OG and Twitter meta plus an oEmbed document, serves a live Server-Sent
Events stream, and renders under a strict sandbox CSP on an opaque origin. See the
[artifact authoring standard](https://docs.derive.to/artifacts/authoring/) for authoring and
embed details.

## License

[Functional Source License (FSL-1.1-ALv2)](LICENSE), fair source. Run, modify, and self-host
Derive freely for any purpose except offering it as a competing commercial product or service.
Each release automatically converts to Apache-2.0 two years after it ships. See the
[plain-English licensing guide](https://docs.derive.to/reference/licensing/).
