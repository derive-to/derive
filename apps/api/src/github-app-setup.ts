// One-click GitHub App registration via the App-manifest flow. Instead of asking
// a self-hoster to hand-create an App and paste five secrets, we POST a manifest
// to GitHub; they click "Create GitHub App" once and GitHub redirects back with a
// temporary code we trade for the App's permanent credentials (see lib/github-app
// convertManifestCode). Two pages: the auto-submitting manifest form, and a
// success/failure landing. Styled like the CLI callback so setup feels like Dock.

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  )

const MARK = `<svg class="mk" viewBox="0 0 32 32" fill="none" aria-hidden="true">
  <rect x="1" y="1" width="30" height="30" rx="8" fill="#2a2540"/>
  <path d="M16 7l7 7v11h-4.6v-6.2h-4.8V25H9V14l7-7z" fill="none" stroke="#8a7dc0" stroke-width="1.7" stroke-linejoin="round"/>
  <rect x="13.6" y="6.4" width="4.8" height="4.8" rx="1.2" fill="#655999"/>
</svg>`

const STYLE = `<style>
  :root{
    --paper:#f6f0e3;--panel:#fdf8ec;--panel-2:#f6efe0;--ink:#2a2540;--ink-soft:#46415c;
    --muted:#6b6680;--line:#e4dcc9;--accent:#655999;--accent-2:#8a7dc0;--good:#6f7a35;
    --good-soft:#ebedda;--bad:#a04425;
    --display:"Space Grotesk",ui-sans-serif,system-ui,sans-serif;
    --sans:"Inter",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
    --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
  }
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;color:var(--ink);
    background:var(--paper);font:15px/1.55 var(--sans);-webkit-font-smoothing:antialiased}
  .card{width:100%;max-width:460px;background:var(--panel);border:1px solid var(--line);border-radius:20px;
    padding:32px 32px 26px;box-shadow:0 1px 2px rgba(42,37,64,.04),0 24px 60px -22px rgba(42,37,64,.32)}
  .brand{display:flex;align-items:center;gap:10px;margin-bottom:22px}
  .mk{width:30px;height:30px;display:block;flex:none}
  .brand .name{font-family:var(--display);font-weight:600;font-size:17px;letter-spacing:-.02em}
  .badge{margin-left:auto;font-family:var(--mono);font-size:10px;font-weight:600;letter-spacing:.05em;
    text-transform:uppercase;padding:4px 9px;border-radius:999px}
  .badge.ok{background:var(--good-soft);color:var(--good)}
  .badge.err{background:#f1e1d6;color:var(--bad)}
  h1{font-family:var(--display);font-weight:600;font-size:23px;line-height:1.2;letter-spacing:-.02em;margin:0 0 7px}
  .sub{color:var(--ink-soft);font-size:14px;margin:0 0 20px}
  .btn{display:inline-block;padding:10px 17px;border-radius:10px;font:600 14px var(--sans);cursor:pointer;
    border:1px solid var(--accent);background:var(--accent);color:#fff;text-decoration:none}
  .btn:hover{filter:brightness(1.07)}
  .foot{color:var(--muted);font-size:12.5px;line-height:1.5;margin:20px 0 0}
  .err{color:var(--bad);font-size:14px;margin:0 0 4px;font-weight:500}
</style>`

const SHELL = (title: string, badge: string, body: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${title} · Dock</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Space+Grotesk:wght@500;600;700&display=swap" rel="stylesheet">
${STYLE}</head>
<body><main class="card"><div class="brand">${MARK}<span class="name">Dock</span>${badge}</div>
${body}</main></body></html>`

// ---- The permission/event spec Dock's CURRENT code needs ------------------
// SINGLE SOURCE OF TRUTH. The manifest is born with these, and the live App is
// diffed against these on every settings load (routes/sync.ts) — a gap surfaces
// the in-app "update permissions" banner. To request a NEW permission as a feature
// lands, add ONE line here, deploy, and the banner walks the owner through it.
//
// GitHub has NO API to change a live App's permissions (the whole Apps REST API is
// read-only for app config — PATCH /app doesn't exist). The owner toggles + saves
// once on github.com/settings/apps/{slug}/permissions, then each install approves;
// the `installation`/`new_permissions_accepted` webhook + a live GET /app re-check
// confirm it. So this constant drives "what we want"; GitHub holds "what we have".
//
// contents+metadata (read) mirror docs; pull_requests is now WRITE — Dock posts a PR
// review/issue comment when someone comments on a PR-sourced artifact, and receives
// `pull_request` + comment events to preview PR docs and mirror PR comments back into
// Dock (the bidirectional collaboration loop). push + pull_request drive auto-sync.
export const REQUIRED_PERMISSIONS: Record<string, string> = {
  contents: "read",
  metadata: "read",
  pull_requests: "write",
}
// Only permission-backed events belong here (push needs contents, the pull_request +
// comment events need pull_requests). The installation + installation_repositories
// lifecycle events are delivered to every App automatically — listing them here is
// rejected by GitHub. `issue_comment` carries PR conversation comments; the inline
// review comments arrive as `pull_request_review_comment`.
export const REQUIRED_EVENTS = [
  "push",
  "pull_request",
  "issue_comment",
  "pull_request_review_comment",
]

/** The GitHub App manifest: what permissions/events/URLs the new App is born with.
 *  Consumes REQUIRED_PERMISSIONS/REQUIRED_EVENTS so a fresh App is always current.
 *  Exported so a test can lock the exact shape GitHub accepts (we regressed on
 *  default_events, public, and setup_url during the live rollout). */
export const buildManifest = (baseUrl: string, host: string) => ({
  name: `Dock · ${host}`,
  url: baseUrl,
  // Where GitHub sends the browser after the App is CREATED (manifest → code).
  redirect_url: new URL("/settings/github/app/created", baseUrl).toString(),
  hook_attributes: { url: new URL("/v1/sync/github/webhook", baseUrl).toString(), active: true },
  // Where GitHub sends the browser after the App is INSTALLED — our callback
  // records the installation (with the signed state) then bounces to the picker.
  setup_url: new URL("/v1/sync/github/callback", baseUrl).toString(),
  // Public so it can be installed on organizations too, not just the owner's
  // personal account (GitHub restricts a private App to its owner account). It's
  // read-only, and an installation only matters once bound to a workspace via our
  // signed-state callback, so a stray direct install is inert.
  public: true,
  default_permissions: REQUIRED_PERMISSIONS,
  default_events: REQUIRED_EVENTS,
})

/**
 * The manifest form page. Auto-POSTs to GitHub's App-creation endpoint with the
 * manifest + our signed `state`; GitHub shows a "Create GitHub App" confirmation,
 * then redirects to the created-callback. A no-JS button is the fallback.
 */
export function manifestFormHTML(props: { baseUrl: string; state: string }): string {
  const { baseUrl } = props
  const host = (() => {
    try {
      return new URL(baseUrl).host
    } catch {
      return "self-hosted"
    }
  })()
  const action = `https://github.com/settings/apps/new?state=${encodeURIComponent(props.state)}`
  const manifestJson = JSON.stringify(buildManifest(baseUrl, host))
  return SHELL(
    "Set up GitHub App",
    "",
    `<h1>Create your GitHub App</h1>
    <p class="sub">This opens GitHub to create a Dock app for your account. You install it on the repos you want to mirror — no tokens to paste.</p>
    <form id="f" method="post" action="${esc(action)}">
      <input type="hidden" name="manifest" value="${esc(manifestJson)}"/>
      <button class="btn" type="submit">Continue to GitHub</button>
    </form>
    <p class="foot">Dock asks for <strong>Contents: read</strong>, <strong>Metadata: read</strong> to mirror your docs, and <strong>Pull requests: write</strong> to sync comments to and from PRs.</p>
    <script>setTimeout(function(){document.getElementById("f").submit()},400)</script>`,
  )
}

/** The landing GitHub redirects to after the App is created (or if it failed). */
export function setupResultHTML(props: { ok: boolean; slug?: string; error?: string }): string {
  if (!props.ok) {
    return SHELL(
      "Setup failed",
      `<span class="badge err">Failed</span>`,
      `<h1>Setup didn't complete</h1>
      <p class="err">${esc(props.error || "The GitHub App could not be created.")}</p>
      <p class="foot"><a class="btn" href="/settings/github/app/new">Try again</a></p>`,
    )
  }
  return SHELL(
    "GitHub App ready",
    `<span class="badge ok">Connected</span>`,
    `<h1>Your GitHub App is ready</h1>
    <p class="sub">${props.slug ? `<code>${esc(props.slug)}</code> ` : ""}is set up. Head back to Settings to install it on your repos.</p>
    <p class="foot"><a class="btn" href="/settings?tab=github">Back to Settings</a></p>`,
  )
}
