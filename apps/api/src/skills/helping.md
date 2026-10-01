---
name: helping
summary: questions about Derive itself: where a thing lives, what a word means, and who may change it
order: 10
---
# Helping someone use Derive

Every other skill is about doing work IN a workspace. This one is about the app around it: "how
do I add someone", "where do sources live", "what is a review round", "why can't I publish". Those
questions are answered here rather than in workspace documents. Searching the library first can
incorrectly suggest that the feature does not exist.

Read this when the question is about DERIVE, not about the workspace's contents.

## How to answer

- **The answer first, then the path.** One route, not a tour.
- **Link it.** `[Settings › Members](/settings/members)`, a real path from the map below. Never
  invent a route, a setting or a button; if it is not written here, say you are not sure rather
  than guessing something plausible.
- **Say who can.** If the action needs a role they may not have, name the role in the same
  breath ("only an Admin can invite"), so they know whether to click or to ask someone.
- **One to three steps.** If it genuinely takes more, say so and give the first one.
- **Do not search first.** These answers are here, not in the library. Search only if they are
  asking about their own content as well.

## The map

| Path | What is there |
| --- | --- |
| `/agents` | Agents: every agent in the workspace, grouped by what needs a person, what is running, what runs on a schedule, and what runs when asked. |
| `/inbox` | Inbox: the jobs waiting on you, answered in place (a choice, a reply, or a link to the page to review), then the pages agents published in the workspace today. |
| `/agents/new` | New agent: a prompt to paste into Claude Code or Codex. The coding session creates the agent over MCP. |
| `/agents/{id}` | One agent. Jobs: what it is doing and has done, with Cancel, Retry, and answers to its questions. Settings: pause, schedules, account, sources, who can ask, its key, delete. |
| `/` | Artifacts, the library: everything in the workspace, most recently updated first. Filter by title, or press Enter to search everything. Collections narrow it. |
| `/search` | Full search across the workspace, by keyword and by meaning. |
| `/favorites` | Documents they starred. |
| `/shared` | Documents other people gave them access to. |
| `/following` | Recent work by the people they follow. |
| `/feedback` | Documents waiting on their review or reply. |
| `/people` | Who is in the workspace, and who they follow. |
| `/papers/new` | Import a paper from arXiv: Derive fetches its LaTeX source and BibTeX and publishes it locked, optionally with its code repository. The paper's page follows the import and holds the implementation and its analysis. |
| `/new` | Write or paste a new document (Markdown or HTML) and publish it. |
| `/welcome` | How to connect an agent over MCP, and how to publish from the CLI. Reachable any time. |
| `/artifacts/{short_id}` | One document: read it, comment, share, see versions. |
| `/users/{handle}` | Someone's public profile and their public work. |
| `/settings` | Everything below. |

## Settings

| Path | What they change there |
| --- | --- |
| `/settings/profile` | Their name, handle, avatar. |
| `/settings/security` | Password and sessions. |
| `/settings/notifications` | Slack DMs, account linking, and what opens automatically for you. |
| `/settings/accounts` | Model accounts: the Claude and Codex accounts agents call a model with: yours, and the workspace's shared ones. Paste a key to connect one; disconnect it here. Only an Admin adds a shared one. |
| `/settings/appearance` | Theme. |
| `/settings/general` | Workspace name, its sharing defaults, and the "Agents can write" switch (Admin only): off, agents stop writing and their jobs wait. |
| `/settings/members` | Invite people, change roles, remove them. Admin only. |
| `/people` | The workspace people directory. |
| `/settings/billing` | Plan, seats, invoices. Admin only. |
| `/settings/machines` | Where agents run: each person's machine running a runner, when it last checked in, and the command that starts a runner. |
| `/settings/sources` | What agents can reach. Connected tools: add an MCP server so an agent can read from it. Secrets: named personal or workspace values (database passwords, API keys) an agent reads as environment variables; add, replace or revoke them. Values are write-only. |
| `/settings/integrations` | Connect Slack and GitHub; manage workspace email notifications. |
| `/settings/webhooks` | Send Derive events to a URL. |
| `/settings/domains` | Serve published pages on a custom domain. |
| `/settings/brandprint` | The workspace's brand: what published pages look like. |
| `/settings/reports` | Content reports, when there are open ones. Admin only. |

## Who can do what

Three roles, and these are the words people see in the app:

| Role | Can |
| --- | --- |
| **Admin** | Everything, plus invite people and manage settings and billing. |
| **Creator** | Create, publish and edit documents. Cannot invite or change settings. |
| **Viewer** | Read and comment. They suggest changes in comments; someone who can publish applies them. |

If somebody cannot do a thing, it is almost always this: say which role it needs and suggest they
ask an Admin. `/settings/members` shows who the Admins are.

## How do I…

**Add someone to the workspace.** `/settings/members`, invite by @handle or email, pick their
role. Admin only. They get an invite link; the roster shows it as pending until they accept.

**Change or remove someone's role.** Same screen, the dropdown on their row.

**Share one document.** Open it and use Share in the top bar. Three levels: *Invited* (only people
you name), *Workspace* (anyone in this workspace), *Anyone* (anyone with the link). Anyone-level
sharing also chooses what a link holder may do: view, comment or edit.

**Stop a document changing.** The ⋯ menu on the document, "Lock changes". It stays readable.

**Publish a document.** Three ways: `/new` to write or paste one, the upload card on `/`, or from
an agent or the CLI (`derive publish`) after connecting at `/welcome`.

**Connect an agent (MCP).** `/welcome` has the setup for whichever agent they use. That is also
how the CLI is authorised.

**Connect a source.** `/settings/sources`, add the MCP server's URL. An agent reaches it once it is added
under Reaches on the agent's Settings tab.

**Make a collection.** The + beside Collections in the sidebar. Then drag documents in, or use the
organize control on a document.

**Tag a document.** The organize control on the document, or in bulk from the library's selection
bar.

**Suggest a change instead of making it.** Select the text and leave a comment saying what to
change. Someone with publish access (or an agent asked from the page's margin) applies it.

**Review what is waiting on me.** `/feedback`.

**Comment on part of a page.** Select the text, then use the bubble that appears. @mention someone
to notify them, or @mention an agent to hand it work.

**See what changed.** Open the document and use History in the top bar. Short inline-edit bursts
stay in one working version. Checkpoints and later versions stay in History and can be restored.

**Follow someone.** Their profile, or the author chip on a document. Their work then shows in
`/following`.

**Get notified in Slack.** `/settings/integrations` connects Slack; channel routing is per-channel
on that same screen. Derive can also send direct messages. Each person controls that at
`/settings/notifications`.

**Put pages on our own domain.** `/settings/domains`.

**Change how published pages look.** `/settings/brandprint`.

**Schedule agent work.** The agent's Settings tab at `/agents/{id}`, under Runs. Make the agent first from `/agents/new`.

**Make an agent.** `/agents/new` gives a prompt to paste into Claude Code or Codex with Derive
connected; the coding session creates it. Change it afterwards on its Settings tab.

**Connect a model account.** `/settings/accounts`: paste a Claude or Codex key. An agent runs on
the account picked on its Settings tab; otherwise on its creator's own account, then the
workspace's shared one. With none of those its jobs fail. Only the account's owner disconnects it.

## Words people ask about

- **Artifact (a "derive"):** one document, such as a page, plan, or report. Versioned from its first
  publish.
- **Version:** a durable document checkpoint. Consecutive inline edits by one person update the
  current working version for five minutes. A pause, another editor, feedback, or a named
  checkpoint starts a new version.
- **Review:** asking a person to look at a version. They answer in comments and send the
  work back with a note; a note that reads "good to go" is the go-signal.
- **Thread:** a comment anchored to a passage. Open until somebody resolves it.
- **Collection:** a folder of documents. A document can be in several.
- **Tag:** a workspace-wide label for finding things across collections.
- **Agent:** a named worker in the workspace: instructions (a page), the sources it may use, a
  model account, and a machine to run on.
- **Job:** one piece of work an agent does: an ask, a scheduled run, or a graph. It ends done,
  failed, or cancelled, or waits on a person.
- **Machine:** where an agent's jobs run: its owner's computer (a runner) or Derive.
- **Brandprint:** the workspace's design and writing guidance for published work.
- **Source:** a connected MCP server an agent can read from.
- **Workspace:** the tenant. People, documents, settings, and billing all belong to one.

## When the answer is no

Say so plainly, and only for things actually absent. Do not invent a screen to be helpful, and do
not promise a feature is "coming". If they ask for something not in this skill and not in the map
above, the honest answer is that you are not sure it exists and they should check `/settings` or
ask an Admin.
