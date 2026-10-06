# Chat: browser proof

Verified on October 5, 2026, with Aside.
The frontend and API run from `fix/chat-loading-navigation`.
Frontend: `http://localhost:3097`. API: `http://localhost:8097`.
The local SQLite database belongs to this worktree.
The signed-in account is Chat QA. Its workspace is Personal.
Chat uses the configured OpenRouter gateway. Successful replies are real model calls.
[API readback](verification.json) records four completed chats and their transcripts.

## Page and navigation

Chat sits directly below Skills in the sidebar and mobile drawer.
The page has one title and a composer at the bottom.
The browser title is Chat · Derive.

![Final Chat page](desktop-final.png)

![Chat below Skills in the mobile navigation drawer](mobile-sidebar.png)

## Responsive mobile layout

Aside has no supported phone emulation control. These screenshots use real iframe viewports.
The buttons above the app belong to the temporary viewport harness.
They are not part of Derive. The harness does not change the app CSS or browser APIs.

| Viewport | Result |
| --- | --- |
| 390 × 844 | Loads, sends, replies, and restores the conversation after reload |
| 390 × 500 | Sends and replies with the composer inside the shorter viewport |
| 320 × 568 | Loads without horizontal overflow; history and navigation open |

Chat answers “Chat” when asked its name. A second conversation returns “Mobile Chat works.”
The mobile Send button measures 44 × 44 pixels.
At 390 × 500, the composer ends at y=488. At 320 × 568, it ends at y=556.

![Mobile name and real reply](mobile-390x844-reply.png)

![Mobile reload restores the conversation](mobile-390x844-reload.png)

![Real reply in the shorter mobile viewport](mobile-390x500-reply.png)

![Small mobile viewport](mobile-320x568.png)

![Mobile history](mobile-320x568-history.png)

## Earlier functional verification

The following screenshots record the functional checks before the final naming and spacing pass.
The final screenshots above show the current interface.

## Reply, continuation, and reload

The model replies “Chat is working.” It recalls that sentence on the next turn.
A reload restores both turns. History opens earlier conversations.

![Conversation after reload](04-chat-reload.png)

## Artifact creation

Chat creates a Markdown artifact with the requested launch date.
The artifact link opens the saved body.

![Chat publishes an artifact](05-chat-publish.png)

![Saved artifact](06-artifact-created.png)

## Artifact Ask

The shared Ask panel reads the artifact and returns October 12, 2026.

![Artifact Ask reads the saved body](07-artifact-ask.png)

## Error recovery

These error cases use deliberate browser fetch faults. They do not represent a model outage.
History and settings GET requests return 403. A send POST returns 503.
Successful requests use the real local API after the fault is removed.

History shows an error and a retry button. Retry restores the conversation and enables the composer.

![History error](08-history-error.png)

![History recovers](09-history-recovered.png)

A rejected send shows an inline error. The draft stays in the composer.
Sending the same draft after recovery gets the real reply “Retry works.”

![Send error preserves the draft](10-send-error.png)

![Send recovers](11-send-recovered.png)

Settings shows a retry control and disables sending. Retry enables the composer.

![Settings error](13-settings-error.png)

![Settings recovers](14-settings-recovered.png)

## Dependency repair

Latest main remains `181184fc`. Its unchanged lockfile reproduces the seven dependency findings.
The updated lockfile passes OSV-Scanner 2.3.8. [Full scan output](dependency-scan.txt).
The scan uses the existing exception file. This change adds no exception.

| Package | Previous version | Current version |
| --- | --- | --- |
| katex | 0.16.47 | 0.18.5 |
| proxy-addr | 2.0.7 | 2.0.8 |
| seroval | 1.5.4 | 1.6.8 |
| smol-toml | 1.8.0 | 1.9.0 |
| source-map-js | 1.2.1 | 1.2.2 |
| global-agent | 3.0.0 | 4.1.3 |
| sprintf-js | 1.1.3 | Removed |

The ONNX installer uses global-agent's `bootstrap` function.
A direct check verifies that function still works after the update.
Global-agent 4.1 removes the logger dependency that brings in sprintf-js.
See the [upstream release](https://github.com/gajus/global-agent/releases/tag/v4.1.0).
The regenerated lockfile also updates two related development tools to 0.9.16.

Chat sends the real reply “Updated Chat works.” after the dependency update.
A page reload restores that reply. The 390 × 500 mobile viewport also loads the conversation.

![Chat after the dependency update](chat-updated-dependencies.png)

![Mobile Chat after the dependency update](mobile-updated-dependencies.png)

## Limits

A simple message also succeeds on derive.to before the change.
This session does not reproduce a complete production backend outage.
The change fixes stale settings, hidden history errors, and the blank wait after an accepted send.
Local browser proof verifies this branch. It does not prove a deployment of this branch.

Physical phone, Safari, and software keyboard behavior remain untested.
The responsive checks do not reproduce the reported phone failure on a physical device.
