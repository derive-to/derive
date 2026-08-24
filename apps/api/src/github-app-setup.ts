// One-click GitHub App registration via the App-manifest flow. Instead of asking
// a self-hoster to hand-create an App and paste five secrets, we POST a manifest
// to GitHub; they click "Create GitHub App" once and GitHub redirects back with a
// temporary code we trade for the App's permanent credentials (see lib/github-app
// convertManifestCode). Two pages: the auto-submitting manifest form, and a
// success/failure landing. Styled like the CLI callback so setup feels like Derive.
import { esc, brandShell as SHELL } from "./brand-page"

// ---- The permission/event spec the STANDARD GitHub source needs --------------
// SINGLE SOURCE OF TRUTH for every newly-created App. GitHub is an on-demand source:
// read pull requests and add a top-level PR conversation comment. Repository mirroring
// is gone and deliberately does not shape new App permissions or events.
//
// GitHub has NO API to change a live App's permissions (the whole Apps REST API is
// read-only for app config — PATCH /app doesn't exist). The owner toggles + saves
// once on github.com/settings/apps/{slug}/permissions, then each install approves.
// Settings uses a live GET /app re-check to confirm it. So this constant drives
// "what we want"; GitHub holds "what we have".
//
// `pull_requests:write` is necessary because GitHub's top-level PR conversation endpoint is
// an Issues route that accepts either Issues:write or Pull requests:write. The latter also
// covers every PR read this source performs. Derive's server-side request policy narrows the
// effective write to comment creation only.
export const REQUIRED_PERMISSIONS: Record<string, string> = {
  metadata: "read",
  pull_requests: "write",
}
// Scheduled/manual runs query GitHub directly. No webhook collection is part of this path.
export const REQUIRED_EVENTS: string[] = []

/** The GitHub App manifest: what permissions/events/URLs the new App is born with.
 *  Consumes REQUIRED_PERMISSIONS/REQUIRED_EVENTS so a fresh App is always current.
 *  Exported so a test can lock the exact shape GitHub accepts (we regressed on
 *  default_events, public, and setup_url during the live rollout). */
export const buildManifest = (baseUrl: string, host: string) => ({
  name: `Derive · ${host}`,
  url: baseUrl,
  // Where GitHub sends the browser after the App is CREATED (manifest → code).
  redirect_url: new URL("/settings/github/app/created", baseUrl).toString(),
  // Where GitHub sends the browser after the App is INSTALLED — our callback
  // starts a user-authorization proof before any installation is persisted.
  setup_url: new URL("/v1/github/callback", baseUrl).toString(),
  callback_urls: [new URL("/v1/github/authorize", baseUrl).toString()],
  request_oauth_on_install: false,
  // Public so it can be installed on organizations too, not just the owner's
  // personal account (GitHub restricts a private App to its owner account). It is
  // server-narrowed to PR reads plus top-level comments, and only matters once bound via our
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
    <p class="sub">This opens GitHub to create a Derive app for your account. Select the repositories agents may read — no tokens to paste and no repository mirror.</p>
    <form id="f" method="post" action="${esc(action)}">
      <input type="hidden" name="manifest" value="${esc(manifestJson)}"/>
      <button class="btn" type="submit">Continue to GitHub</button>
    </form>
    <p class="foot">Derive asks for <strong>Metadata: read</strong> and <strong>Pull requests: write</strong>. The write level is required to add a top-level PR conversation comment; Derive permits no other GitHub write.</p>
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
    <p class="sub">${props.slug ? `<code>${esc(props.slug)}</code> ` : ""}is set up. Head back to Integrations to connect it to the repositories agents may read.</p>
    <p class="foot"><a class="btn" href="/settings/integrations">Back to Integrations</a></p>`,
  )
}
