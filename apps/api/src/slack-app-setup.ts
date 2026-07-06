// One-place Slack app setup for a self-host / new deployment. Slack (unlike GitHub)
// has no browser flow that creates an app AND hands the credentials back — that needs
// an app-configuration token. So instead of asking a deployer to hand-edit a manifest
// (and forget the events URL — the exact gap that leaves reply-back dead), we render
// the manifest ALREADY FILLED with this instance's URL and walk them through the
// three clicks: create-from-manifest, paste three secrets, Add to Slack. The manifest
// is born with the events + interactivity + slash + App Home config, so a fresh
// "Add to Slack" is two-way from the first message — nothing to toggle by hand.
import { esc, brandShell as SHELL } from "./brand-page"

// The bot scopes the app is BORN with — the app's full declared capability across
// every feature (comment mirror, event cards, DMs, slash command, link unfurls, App
// Home). The OAuth install (slackAuthorizeUrl / SLACK_BOT_SCOPES in lib/slack) can
// request a subset of these as features land; the manifest declaring a scope only
// makes it grantable, never auto-granted. Keep this the superset.
export const SLACK_MANIFEST_BOT_SCOPES = [
  "chat:write",
  "chat:write.public",
  "channels:read",
  "channels:join",
  "channels:history",
  "groups:read",
  "groups:history",
  "users:read",
  "users:read.email",
  "im:history",
  "im:write",
  "app_mentions:read",
  "links:read",
  "links:write",
  "commands",
]

/** The Slack app manifest, born with everything Derive's Slack integration needs and
 *  every URL pointed at THIS instance. Single source of truth: the setup page renders
 *  it and `GET /v1/slack/manifest.json` serves it, so there is no hand-edited copy to
 *  drift or leave half-filled. `host` names the app and scopes link unfurls to this
 *  deployment's artifact domain. Exported so a test can lock the shape Slack accepts. */
export const buildSlackManifest = (baseUrl: string, host: string) => {
  const u = (path: string): string => new URL(path, baseUrl).toString()
  return {
    display_information: {
      name: host === "derive.to" ? "Derive" : `Derive · ${host}`,
      description:
        "Get Derive comments, publishes, proposals and reviews in Slack, and reply back from a thread.",
      background_color: "#1a1a2e",
    },
    features: {
      bot_user: { display_name: "Derive", always_online: true },
      // App Home tab: a per-user landing view (published on app_home_opened).
      app_home: {
        home_tab_enabled: true,
        messages_tab_enabled: false,
        messages_tab_read_only_enabled: false,
      },
      slash_commands: [
        {
          command: "/derive",
          url: u("/v1/slack/command"),
          description: "Search Derive artifacts and share them into this channel",
          usage_hint: "find <query>",
          should_escape: false,
        },
      ],
      // link_shared only fires for domains listed here — this deployment's own origin.
      unfurl_domains: [host],
    },
    oauth_config: {
      redirect_urls: [u("/v1/slack/oauth/callback"), u("/v1/slack/link/callback")],
      scopes: { user: ["openid", "email", "profile"], bot: SLACK_MANIFEST_BOT_SCOPES },
    },
    settings: {
      event_subscriptions: {
        request_url: u("/v1/slack/events"),
        bot_events: [
          "message.channels",
          "message.groups",
          "message.im",
          "app_mention",
          "link_shared",
          "app_home_opened",
        ],
      },
      interactivity: { is_enabled: true, request_url: u("/v1/slack/interactivity") },
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
  const manifestJson = JSON.stringify(buildSlackManifest(baseUrl, host), null, 2)
  return SHELL(
    "Set up Slack",
    "",
    `<h1>Create your Slack app</h1>
    <p class="sub">This manifest is filled in for <code>${esc(host)}</code>. Creating the app from it wires up event subscriptions, interactivity, the <code>/derive</code> command and the App Home in one shot, so replies and buttons work the moment you connect.</p>
    <ol class="steps">
      <li>Open <a href="https://api.slack.com/apps" target="_blank" rel="noopener">api.slack.com/apps</a> → <strong>Create New App</strong> → <strong>From a manifest</strong>, and pick your workspace.</li>
      <li>Paste the manifest below (already pointed at this instance) and create the app.</li>
      <li>On <strong>Basic Information</strong>, copy the <strong>Client ID</strong>, <strong>Client Secret</strong> and <strong>Signing Secret</strong> into <code>SLACK_CLIENT_ID</code>, <code>SLACK_CLIENT_SECRET</code> and <code>SLACK_SIGNING_SECRET</code>, then restart Derive.</li>
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
