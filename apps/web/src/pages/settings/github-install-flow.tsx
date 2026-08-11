import { AlertTriangle, CheckCircle2, ExternalLink } from "lucide-react"
import { useEffect } from "react"
import { api, type GithubSyncStatus } from "@/api"
import { SectionTitle } from "@/components/shared/section-title"
import { StatusPanel } from "@/components/shared/status-panel"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { useApiMutation } from "@/lib/use-api-mutation"

// Human labels for the GitHub App permission/event diff (the banner). Keys mirror
// the scopes/events in the server's REQUIRED_PERMISSIONS / REQUIRED_EVENTS.
const PERMISSION_LABELS: Record<string, string> = {
  contents: "Contents",
  metadata: "Metadata",
  pull_requests: "Pull requests",
  issues: "Issues",
  checks: "Checks",
  statuses: "Commit statuses",
  members: "Members",
}
const EVENT_LABELS: Record<string, string> = {
  push: "Push",
  pull_request: "Pull request",
  issues: "Issues",
  issue_comment: "Issue comment",
  check_run: "Check run",
}
const LEVEL_LABELS: Record<string, string> = {
  read: "Read-only",
  write: "Read & write",
  admin: "Admin",
}

// No App yet: one button that kicks off the manifest flow (a top-level nav, since
// it posts a form to GitHub).
export function SetUpApp() {
  return (
    <Card className="flex flex-col items-start gap-3 p-4">
      <div>
        <SectionTitle>Connect GitHub</SectionTitle>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Create a read-only GitHub App for this instance, then install it on the repos you want to
          mirror. No tokens to paste, and pushes sync automatically.
        </p>
      </div>
      <Button variant="default" asChild data-testid="github-setup-app">
        <a href="/settings/github/app/new">Set up GitHub App</a>
      </Button>
    </Card>
  )
}

// App is set up: install on (more) repos, or pick from an existing installation.
export function ConnectViaApp({
  status,
  onPick,
  onRefresh,
}: {
  status: GithubSyncStatus
  onPick: (installationId: string) => void
  onRefresh: () => void
}) {
  const install = useApiMutation({
    mutationFn: () => api.githubInstallUrl(),
    onSuccess: ({ url }) => {
      window.location.href = url
    },
  })
  // On mount (and whenever installations list is empty), fetch from GitHub and seed
  // any existing installations the DB might be missing — covers the recovery case
  // where rows were lost without a full GitHub re-install.
  useEffect(() => {
    if (status.installations.length > 0) return
    api
      .resyncInstallations()
      .then(({ synced }) => {
        if (synced > 0) onRefresh()
      })
      .catch(() => {
        // silent — the Install button is still available as fallback
      })
  }, [status.installations.length, onRefresh])
  const installed = status.installations.length > 0
  const { slug, upToDate, missing, permissionsUrl, approveUrl } = status.app
  const needsPerms =
    upToDate === false &&
    !!missing &&
    (Object.keys(missing.permissions).length > 0 || missing.events.length > 0)
  return (
    <>
      {/* The fragment's children land directly in the section's gap-6 column, so the
          banner needs no margin of its own. */}
      {needsPerms && missing && (
        <div data-testid="github-perms-banner">
          <StatusPanel
            tone="warning"
            layout="inline"
            icon={<AlertTriangle aria-hidden />}
            title="Derive needs updated GitHub permissions"
            description="A new feature needs access GitHub hasn't granted this App yet. Update it on GitHub, save, then approve on your installation."
            action={
              <div className="flex flex-col gap-3">
                <ul role="list" className="flex flex-col gap-1 text-sm text-foreground">
                  {Object.entries(missing.permissions).map(([scope, level]) => (
                    <li key={scope} className="flex items-center gap-1.5">
                      <span className="size-1 rounded-full bg-foreground" aria-hidden />
                      <span className="font-medium">{PERMISSION_LABELS[scope] ?? scope}</span>
                      <span className="text-muted-foreground">
                        → {LEVEL_LABELS[level] ?? level}
                      </span>
                    </li>
                  ))}
                  {missing.events.map((ev) => (
                    <li key={ev} className="flex items-center gap-1.5">
                      <span className="size-1 rounded-full bg-foreground" aria-hidden />
                      <span className="text-muted-foreground">Subscribe to</span>
                      <span className="font-medium">{EVENT_LABELS[ev] ?? ev}</span>
                      <span className="text-muted-foreground">events</span>
                    </li>
                  ))}
                </ul>
                <div className="flex flex-wrap items-center gap-2">
                  {permissionsUrl && (
                    <Button variant="secondary" size="sm" data-testid="github-perms-update" asChild>
                      <a href={permissionsUrl} target="_blank" rel="noreferrer">
                        Update on GitHub →
                      </a>
                    </Button>
                  )}
                  {approveUrl && (
                    <Button variant="outline" size="sm" data-testid="github-perms-approve" asChild>
                      <a href={approveUrl} target="_blank" rel="noreferrer">
                        Approve on installation →
                      </a>
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    data-testid="github-perms-recheck"
                    onClick={onRefresh}
                  >
                    Re-check
                  </Button>
                </div>
              </div>
            }
          />
        </div>
      )}
      <Card className="flex flex-col gap-3 p-4">
        <div className="flex items-start gap-2.5">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
          <div className="min-w-0 flex-1">
            <SectionTitle>GitHub App connected</SectionTitle>
            {installed ? (
              <p className="mt-0.5 text-sm text-muted-foreground">
                Pick a repository to mirror into Derive, or install on more accounts.
              </p>
            ) : (
              <>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  Install Derive on the GitHub repos you want to mirror — then pick them here.
                </p>
                <Button
                  data-testid="github-install"
                  variant="default"
                  className="mt-3"
                  onClick={() => install.mutate()}
                  disabled={install.isPending}
                >
                  {install.isPending ? "Opening GitHub…" : "Install on GitHub →"}
                </Button>
              </>
            )}
          </div>
          {installed && (
            <Button
              data-testid="github-install-more"
              variant="outline"
              size="sm"
              onClick={() => install.mutate()}
              disabled={install.isPending}
            >
              {install.isPending ? "Opening GitHub…" : "Install on more"}
            </Button>
          )}
        </div>
        {installed && (
          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
            <span className="text-sm text-muted-foreground">Pick a repository:</span>
            {status.installations.map((i) => (
              <Button
                key={i.installation_id}
                data-testid="github-pick-installation"
                variant="secondary"
                size="sm"
                onClick={() => onPick(i.installation_id)}
              >
                {i.account_login ? `${i.account_login} →` : "Choose repos →"}
              </Button>
            ))}
          </div>
        )}
        {slug && (
          <div className="flex items-center gap-1.5 border-t border-border pt-2">
            <a
              href={`https://github.com/settings/apps/${slug}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground hover:underline"
              data-testid="github-app-settings-link"
            >
              Manage App on GitHub
              <ExternalLink className="size-3 shrink-0" aria-hidden />
            </a>
            <span className="text-sm text-muted-foreground">— update permissions or uninstall</span>
          </div>
        )}
      </Card>
    </>
  )
}
