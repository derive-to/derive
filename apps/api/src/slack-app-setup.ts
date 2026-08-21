// One-place Slack app setup for a self-host / new deployment. Slack (unlike GitHub)
// has no browser flow that creates an app AND hands the credentials back — that needs
// an app-configuration token. So instead of asking a deployer to hand-edit a manifest
// (and forget the events URL — the exact gap that leaves reply-back dead), we render
// the manifest ALREADY FILLED with this instance's URL and walk them through the
// three clicks: create-from-manifest, paste three secrets, Add to Slack. The manifest
// is born with the events config, so a fresh "Add to Slack" is two-way from the first
// message — nothing to toggle by hand.
import { esc, brandShell as SHELL } from "./brand-page"
import { SLACK_BOT_SCOPES, SLACK_USER_SCOPES } from "./lib/slack"
import { SLACK_CAPTURE_CALLBACK } from "./lib/slack-capture"

/** The Slack app manifest, born with everything Derive's Slack integration needs and
 *  every URL pointed at THIS instance. Single source of truth: the setup page renders
 *  it and `GET /v1/slack/manifest.json` serves it, so there is no hand-edited copy to
 *  drift or leave half-filled. Exported so a test can lock the shape Slack accepts. */
export const buildSlackManifest = (baseUrl: string) => {
  const u = (path: string): string => new URL(path, baseUrl).toString()
  return {
    display_information: {
      // Slack hard-caps this at 140 characters and REJECTS the whole manifest past it
      // (apps.manifest.validate → invalid_manifest / failed_constraint). This read 156 and
      // so could never be pasted into "Create from manifest" — the setup page handed every
      // deployer a manifest Slack refused. Kept under the cap with headroom; the test below
      // pins it, the same way the 35-char name cap is pinned.
      name: "Derive",
      description:
        "Derive comments, publishes and review updates in a Slack channel. Reply from the thread; DMs for mentions, review requests and shares.",
      background_color: "#1a1a2e",
    },
    features: {
      // THE MESSAGES TAB, which is what makes the app DM-able at all.
      //
      // Omitting app_home does not leave Slack's default alone — applying a manifest without it
      // turns the Messages tab OFF, so the app stops accepting direct messages and the person
      // sees no way to write to it. Subscribing message.im and holding im:history buys nothing
      // if nobody can open the conversation, which is exactly how this shipped broken: the event
      // and the scope were right and the tab was gone.
      //
      // read_only must be false too — true renders a tab you can look at and cannot type into.
      app_home: {
        home_tab_enabled: false,
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      bot_user: { display_name: "Derive", always_online: true },
      // The domains whose links this app unfurls. A registered domain matches all of its
      // SUBDOMAINS and paths, so one entry covers the instance host and every vanity
      // subdomain under it. Slack caps this at 5 and — unlike the events below — a change
      // here only takes effect after the app is REINSTALLED in each workspace. A workspace
      // on its own BYO custom domain is therefore out of reach: those hosts aren't known at
      // manifest time and there is no room to enumerate them.
      unfurl_domains: [hostOf(baseUrl)],
      slash_commands: [
        {
          command: "/derive",
          url: u("/v1/slack/commands"),
          // Slack shows BOTH of these in the autocomplete as soon as someone types `/derive`,
          // and they are the only place the subcommands are discoverable — there is no other
          // surface that lists them. A description naming only search is why `/derive subscribe`
          // reads as if it does not exist.
          description: "Search Derive, or choose what this channel gets",
          usage_hint: "[query] | subscribe [collection] | unsubscribe | settings | help",
          should_escape: false,
        },
      ],
      // "Save to Derive" on any message's overflow menu — the capture path (lib/slack-capture.ts).
      // A MESSAGE shortcut rather than a global one: it needs the message it was fired on, and a
      // global shortcut carries none. It belongs under `features`, beside slash_commands, NOT
      // under `settings` beside interactivity — Slack's manifest schema rejects unknown keys, so
      // the misplacement did not degrade to "shortcut missing", it failed the whole manifest.
      // A manifest is the only way to declare one; an existing app picks it up when the manifest
      // is re-applied, and the shortcut then appears without a per-workspace reinstall (it needs
      // no new scope — `commands` already covers it).
      shortcuts: [
        {
          name: "Save to Derive",
          type: "message",
          callback_id: SLACK_CAPTURE_CALLBACK,
          description: "Save this message as a comment on a Derive doc",
        },
      ],
    },
    oauth_config: {
      // The bot install callback + the per-user "Sign in with Slack" (OIDC) link callback.
      redirect_urls: [u("/v1/slack/oauth/callback"), u("/v1/slack/link/callback")],
      // BOTH lists, and the user one is not optional: this manifest declares the link callback
      // above, so an app built without the user scopes looks configured for account linking and
      // refuses the very first authorize call. Sourced from lib/slack.ts so the manifest and the
      // authorize URL cannot drift.
      scopes: { bot: SLACK_BOT_SCOPES, user: SLACK_USER_SCOPES },
    },
    settings: {
      event_subscriptions: {
        request_url: u("/v1/slack/events"),
        // Channels, private channels, and DIRECT MESSAGES to the app.
        //
        // `message.im` was subscribed here once and removed: every reply was gated on a
        // slack_thread_link lookup (channel + thread_ts) written only by the channel
        // comment-mirror, so a DM could never match, while Slack still refused the manifest
        // over the missing scope ("message.im event is missing scope(s): im:history"). The
        // note left behind said to add the event and the scope together once something could
        // actually answer a DM. That is this: /v1/slack/events now routes a DM straight into
        // the chat lane instead of through the thread-link gate, so the event has a reader and
        // im:history is in SLACK_BOT_SCOPES beside it.
        //
        // app_uninstalled / tokens_revoked need no scope, and they are the only way to learn
        // that the stored bot token died without waiting for a delivery to fail — which never
        // happens on a workspace with no Slack traffic, leaving Settings claiming "connected".
        bot_events: [
          "message.channels",
          "message.groups",
          "message.im",
          "link_shared",
          // @Derive, anywhere the bot is invited — the mention lane that does not need a
          // mirrored thread underneath it. Paired with the `app_mentions:read` scope in
          // SLACK_BOT_SCOPES: Slack refuses a manifest that declares one without the other,
          // which is how the two previous scope/event mismatches shipped broken.
          "app_mention",
          // Work Objects: fired when someone CLICKS an unfurled card, opening the flexpane. It
          // carries the clicking user, which is what makes that surface per-viewer — the thing
          // link_shared and chat.unfurl cannot be. Needs no new scope, so an existing install
          // picks it up on a manifest re-apply without a reconnect.
          "entity_details_requested",
          "app_uninstalled",
          "tokens_revoked",
        ],
      },
      // Buttons on comment cards (resolve / reopen a thread) POST here.
      interactivity: {
        is_enabled: true,
        request_url: u("/v1/slack/interactivity"),
      },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  }
}

/** Derive the app name host from a base URL (falls back to a readable label). */
export const hostOf = (baseUrl: string): string => {
  try {
    return new URL(baseUrl).host
  } catch {
    return "self-hosted"
  }
}

/** The admin setup page: the pre-filled manifest + the three steps to a live app.
 *  No auto-POST (Slack can't accept one) — a copy button and a link to the dashboard. */
export function slackSetupHTML(baseUrl: string): string {
  const host = hostOf(baseUrl)
  const manifestJson = JSON.stringify(buildSlackManifest(baseUrl), null, 2)
  return SHELL(
    "Set up Slack",
    "",
    `<h1>Create your Slack app</h1>
    <p class="sub">This manifest is filled in for <code>${esc(host)}</code>. Creating the app from it wires up event subscriptions in one shot, so thread replies flow back into Derive the moment you connect.</p>
    <ol class="steps">
      <li>Open <a href="https://api.slack.com/apps" target="_blank" rel="noopener">api.slack.com/apps</a> → <strong>Create New App</strong> → <strong>From a manifest</strong>, and pick your workspace.</li>
      <li>Paste the manifest below (already pointed at this instance) and create the app.</li>
      <li>On <strong>Basic Information</strong>, enable <strong>Work Object Previews</strong> and select <strong>Content item</strong>. That enables the rich document/question cards and their reply panel; Derive still falls back to a normal Slack card when it is unavailable.</li>
      <li>Copy the <strong>Client ID</strong>, <strong>Client Secret</strong> and <strong>Signing Secret</strong> into <code>SLACK_CLIENT_ID</code>, <code>SLACK_CLIENT_SECRET</code> and <code>SLACK_SIGNING_SECRET</code>, then restart Derive.</li>
      <li>Come back to <strong>Settings → Integrations</strong> and click <strong>Add to Slack</strong>.</li>
    </ol>
    <div class="code">
      <button class="copy" type="button" id="cp">Copy</button>
      <pre id="mf">${esc(manifestJson)}</pre>
    </div>
    <div class="row">
      <a class="btn" href="https://api.slack.com/apps" target="_blank" rel="noopener">Open Slack dashboard</a>
      <a class="btn ghost" href="/settings/integrations">Back to Settings</a>
    </div>
    <p class="foot">The manifest is also served at <code>/v1/slack/manifest.json</code>. Bot tokens are encrypted at rest with <code>DERIVE_AUTH_SECRET</code>.</p>
    <script>
      document.getElementById("cp").addEventListener("click", function(){
        navigator.clipboard.writeText(document.getElementById("mf").textContent).then(function(){
          var b=document.getElementById("cp"); b.textContent="Copied"; setTimeout(function(){b.textContent="Copy"},1400)
        })
      })
    </script>`,
  )
}
