Sharing an artifact answers three separate questions: who can discover it, who can open it,
and what an authenticated visitor may do. Keeping those choices separate lets you share a
draft with a customer without publishing it in a directory, or list a team document without
opening it to the internet.

## Choose an audience

Open an artifact and use **Share**. Start with the narrowest audience that fits the review:

| Audience | Who can open it | Typical use |
| --- | --- | --- |
| **Invited** | Only people explicitly added to the artifact or one of its collections | Sensitive drafts and named reviewers |
| **Workspace** | Members of the artifact's workspace, at their workspace role | Internal plans, reports, and team documentation |
| **Anyone** | Anyone holding the URL; anonymous visitors remain read-only | Customer review links, public launches, and embeds |

Choosing **Anyone** also lets you select what an authenticated link holder may do: view,
comment, or edit. An anonymous visitor is always limited to viewing, even when the link grants
more to signed-in people.

## Understand workspace roles

Workspace roles are shown in the product as:

- **Admin:** manages the workspace, its members, settings, billing, and every artifact.
- **Creator:** creates, publishes, edits, and reviews work without managing the workspace.
- **Viewer:** reads and comments. Proposed edits wait for a Creator or Admin to decide.

Workspace access uses each person's existing role. There is no second per-artifact role to
configure for the whole workspace. If somebody opens a workspace-only artifact while another
workspace is active, Derive offers to switch rather than exposing the artifact to an unrelated
workspace.

Agents borrow no greater standing than the person and workspace that authorized them. They can
publish or propose within that standing, but an agent, API token, or operator token cannot record
the human approval that closes a review.

## Control discovery separately

Access to a URL does not automatically list the artifact:

- **Not listed** keeps it out of libraries and public discovery. People can still use a link or
  explicit invitation.
- **Workspace library** makes it discoverable to workspace members and therefore requires
  Workspace access.
- **Public directory** makes it publicly discoverable and therefore requires an Anyone link.

This distinction is useful for external review: choose **Anyone · Can view** and leave the
artifact unlisted. The reviewer gets a durable URL without the work appearing in a directory.

## Add a password when the URL is not enough

An Anyone link may also require a password. The password gates the outside-world link; it does
not replace a signed-in member's workspace access or an explicit invitation. Share the password
through a different channel from the artifact URL.

Changing the password invalidates the previous unlock. Removing Anyone access closes the public
link altogether.

## Collections carry their access to their contents

An explicit collection member receives that collection role on every artifact in it. A
workspace-visible collection likewise lets workspace members open its contents at their normal
workspace roles. An invite-only collection grants nothing merely because somebody belongs to the
workspace.

An artifact can belong to several collections. The strongest valid explicit or workspace grant
wins; the artifact's own Anyone link remains an independent choice.

## Common sharing recipes

| Goal | Audience | Discovery | Additional control |
| --- | --- | --- | --- |
| Private draft for two reviewers | Invited | Not listed | Add the two people |
| Internal team document | Workspace | Workspace library | None |
| Unlisted customer review | Anyone · Can comment | Not listed | Optional password |
| Public launch page | Anyone · Can view | Public directory | None |
| External editor without broad workspace access | Invited | Not listed | Grant edit to that person |

When a review is ready to close, the final approval must come from a directly signed-in person
with approval standing. Derive records both that person's stable identity and a display-name
snapshot with the decision.
