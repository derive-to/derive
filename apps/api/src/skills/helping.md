---
name: helping
summary: questions about Derive itself: where a thing lives, what a word means, and who may change it
order: 7
---
# Helping someone use Derive

Every other skill is about doing work IN a workspace. This one is about the app around it: "how
do I add someone", "where do sources live", "what is a proposal", "why can't I publish". Those
questions have no answer in anybody's documents, so searching for one wastes a turn and comes
back with nothing — which reads as "Derive does not do that" when the truth is "it is two clicks
away".

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
| `/` | The library: everything in the workspace, most recently updated first. Filter by title, or press Enter to search everything. Collections narrow it. |
| `/search` | Full search across the workspace, by keyword and by meaning. |
| `/chat` | The full-page chat with Derive. The same conversation as the dock beside the page. |
| `/favorites` | Documents they starred. |
| `/shared` | Documents other people gave them access to. |
| `/following` | Recent work by the people they follow. |
| `/feedback` | Documents waiting on their review or reply. |
| `/contexts` | Packaged agents: a named setup somebody can ask, with its own access. |
| `/people` | Who is in the workspace, and who they follow. |
| `/new` | Write or paste a new document (Markdown or HTML) and publish it. |
| `/welcome` | How to connect an agent over MCP, and how to publish from the CLI. Reachable any time. |
| `/artifacts/{short_id}` | One document: read it, comment, propose, share, see versions. |
| `/users/{handle}` | Someone's public profile and their public work. |
| `/roadmap` | What is shipped and what is coming. |
| `/settings` | Everything below. |

## Settings

| Path | What they change there |
| --- | --- |
| `/settings/profile` | Their name, handle, avatar. |
| `/settings/security` | Password and sessions. |
| `/settings/model-plans` | Their own model login, so their agent runs on their key. |
| `/settings/appearance` | Theme. |
| `/settings/general` | Workspace name and its defaults. |
| `/settings/members` | Invite people, change roles, remove them. Admin only. |
| `/settings/people` | Directory settings for the workspace. |
| `/settings/billing` | Plan, seats, invoices. Admin only. |
| `/settings/integrations` | Slack, email notifications, GitHub comment mirroring. |
| `/settings/sources` | Connect an MCP server so an agent can read from it. |
| `/settings/brandprint` | The workspace's brand: what published pages look like. |
| `/settings/github` | Install the GitHub app, pick repos, PR previews. |
| `/settings/webhooks` | Send Derive events to a URL. |
| `/settings/agents` | Register an agent, mint or rotate its token. |
| `/settings/automations` | Scheduled or triggered agent work. |
| `/settings/domains` | Serve published pages on a custom domain. |
| `/settings/reports` | Content reports, when there are open ones. Admin only. |

## Who can do what

Three roles, and these are the words people see in the app:

| Role | Can |
| --- | --- |
| **Admin** | Everything, plus invite people and manage settings and billing. |
| **Creator** | Create, publish and edit documents. Cannot invite or change settings. |
| **Viewer** | Read and comment. Their edits are filed as proposals for someone to approve. |

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

**Connect a source.** `/settings/sources`, add the MCP server's URL. An agent working for them can
then read from it. This is different from `/settings/agents`, which is about agents that act IN
Derive.

**Make a collection.** The + beside Collections in the sidebar. Then drag documents in, or use the
organize control on a document.

**Tag a document.** The organize control on the document, or in bulk from the library's selection
bar.

**Suggest a change instead of making it.** Edit and choose to propose. Viewers always propose. The
owner sees it on the document and approves or asks for changes.

**Review what is waiting on me.** `/feedback`.

**Comment on part of a page.** Select the text, then use the bubble that appears. @mention someone
to notify them, or @mention an agent to hand it work.

**See what changed.** Open the document and use History in the top bar. Every version is kept, and
any version can be restored.

**Follow someone.** Their profile, or the author chip on a document. Their work then shows in
`/following`.

**Get notified in Slack.** `/settings/integrations` connects Slack; channel routing is per-channel
on that same screen. Derive can also DM them.

**Put pages on our own domain.** `/settings/domains`.

**Change how published pages look.** `/settings/brandprint`.

**Schedule agent work.** `/settings/automations`.

**Use my own model key.** `/settings/model-plans`.

**Turn chat off for the workspace.** `/settings/general`. Admin only.

## Words people ask about

- **Artifact (a "derive")** — one document. A page, a plan, a report. Versioned from its first
  publish.
- **Version** — every publish keeps the last one. Nothing is overwritten, and any version can be
  restored.
- **Proposal** — a change waiting for approval instead of going live. What a Viewer's edit
  becomes, and what anyone can choose deliberately.
- **Review** — asking a person to look at a version, answered inline.
- **Thread** — a comment anchored to a passage. Open until somebody resolves it.
- **Collection** — a folder of documents. A document can be in several.
- **Tag** — a workspace-wide label, for finding things across collections.
- **Context** — a packaged agent: a named setup anyone can ask, with its own access.
- **Agent** — a registered principal that acts for a person, with its own token, capped by that
  person's seat.
- **Automation** — agent work on a schedule or a trigger.
- **Brandprint** — the workspace's brand, applied to published pages.
- **Source** — a connected MCP server an agent can read from.
- **Workspace** — the tenant. People, documents, settings and billing all belong to one.

## When the answer is no

Say so plainly, and only for things actually absent. Do not invent a screen to be helpful, and do
not promise a feature is "coming". If they ask for something not in this skill and not in the map
above, the honest answer is that you are not sure it exists and they should check `/settings` or
ask an Admin.
