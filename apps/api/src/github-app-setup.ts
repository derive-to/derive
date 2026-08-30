// One-click GitHub App registration via the App-manifest flow. Instead of asking
// a self-hoster to hand-create an App and paste five secrets, we POST a manifest
// to GitHub; they click "Create GitHub App" once and GitHub redirects back with a
// temporary code we trade for the App's permanent credentials (see lib/github-app
// convertManifestCode). Two pages: the owner-selection manifest form, and a
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
export const ACTIONS_PERMISSION = { actions: "write" } as const
export const MANIFEST_PERMISSIONS: Record<string, string> = {
  ...REQUIRED_PERMISSIONS,
  ...ACTIONS_PERMISSION,
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
  // An already-installed App opens GitHub's repository-selection screen. Return to the
  // same callback after that update too, or Derive never receives the installation id.
  setup_on_update: true,
  callback_urls: [new URL("/v1/github/authorize", baseUrl).toString()],
  request_oauth_on_install: false,
  // Public so it can be installed on organizations too, not just the owner's
  // personal account (GitHub restricts a private App to its owner account). It is
  // server-narrowed to PR reads plus top-level comments, and only matters once bound via our
  // signed-state callback, so a stray direct install is inert.
  public: true,
  default_permissions: MANIFEST_PERMISSIONS,
  default_events: REQUIRED_EVENTS,
})

/** The manifest form page. The operator chooses who owns the App before GitHub creates it.
 * GitHub shows that owner as the developer, so silently defaulting to the signed-in person's
 * account is both surprising and difficult to repair after installations exist. */
export function manifestFormHTML(props: { baseUrl: string; state: string }): string {
  const { baseUrl } = props
  const host = (() => {
    try {
      return new URL(baseUrl).host
    } catch {
      return "self-hosted"
    }
  })()
  const personalAction = `https://github.com/settings/apps/new?state=${encodeURIComponent(props.state)}`
  const manifestJson = JSON.stringify(buildManifest(baseUrl, host))
  return SHELL(
    "Set up GitHub App",
    "",
    `<h1>Create your GitHub App</h1>
    <p class="sub">Create the App under the organization that operates this Derive instance. GitHub shows that account as the App developer.</p>
    <form id="f" method="post" action="${esc(personalAction)}">
      <div class="field">
        <label for="owner">GitHub organization</label>
        <input id="owner" name="owner" autocomplete="organization" placeholder="derive-to" pattern="[A-Za-z0-9-]{1,39}"/>
        <p class="hint">Leave this blank only if a personal account should own the App.</p>
      </div>
      <input type="hidden" name="manifest" value="${esc(manifestJson)}"/>
      <div class="row">
        <button class="btn" type="submit">Continue to GitHub</button>
        <button class="btn ghost" type="submit" formnovalidate data-personal>Use personal account</button>
      </div>
    </form>
    <p class="foot">Derive asks for <strong>Metadata: read</strong>, <strong>Pull requests: write</strong>, and <strong>Actions: write</strong>. Server-side policies limit these to PR reads, one top-level PR comment, workflow status, and dispatch of workflows named <strong>derive-*.yml</strong>.</p>
    <script>
      (function(){
        var form=document.getElementById("f"),owner=document.getElementById("owner"),personal=${JSON.stringify(personalAction)};
        form.addEventListener("submit",function(event){
          if(event.submitter&&event.submitter.hasAttribute("data-personal")){form.action=personal;return}
          var value=owner.value.trim();
          if(!value){event.preventDefault();owner.setCustomValidity("Enter the GitHub organization that should own this App, or choose personal account.");owner.reportValidity();return}
          owner.setCustomValidity("");
          form.action="https://github.com/organizations/"+encodeURIComponent(value)+"/settings/apps/new?state="+${JSON.stringify(encodeURIComponent(props.state))};
        });
        owner.addEventListener("input",function(){owner.setCustomValidity("")});
      })()
    </script>`,
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
