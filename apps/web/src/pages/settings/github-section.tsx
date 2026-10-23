import { useQuery, useQueryClient } from "@tanstack/react-query"
import { AlertTriangle, ArrowUpRight, ChevronRight } from "lucide-react"
import { useEffect, useState } from "react"
import { api, type GithubIntegrationAccount, type GithubStatus } from "@/api"
import { AccountMark } from "@/components/shared/account-mark"
import { AdminNote } from "@/components/shared/admin-note"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { ConnectPrompt } from "@/components/shared/connect-prompt"
import { ListRow } from "@/components/shared/list-row"
import { LoadError } from "@/components/shared/load-error"
import { SettingsGroup } from "@/components/shared/settings-group"
import { StatusBadge } from "@/components/shared/status-badge"
import { StatusPanel } from "@/components/shared/status-panel"
import { Button } from "@/components/ui/button"
import { toast } from "@/components/ui/sonner"
import {
  connectionsQuery,
  githubQuery,
  githubRepositoriesQuery,
  workspaceQuery,
} from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import { useOneShotParams } from "@/lib/use-one-shot-params"
import { cn } from "@/lib/utils"
import { SettingsListSkeleton } from "./settings-list-skeleton"

// Settings › Sources › GitHub: which GitHub accounts this workspace reaches, and the
// repositories each one covers. Connecting always goes through /v1/github/install, which
// offers installations not yet connected here beside GitHub's own account picker; it never
// binds one on its own. Agents are given a GitHub account on their Settings tab.

const CONNECT_URL = "/v1/github/install"

const INSTALL_MESSAGES: Record<string, { title: string; description: string }> = {
  requested: {
    title: "Waiting for an organization owner",
    description: "GitHub sent them your request. Connect again once they approve it.",
  },
  canceled: {
    title: "GitHub connection canceled",
    description: "Nothing changed.",
  },
  expired: {
    title: "The GitHub sign-in expired",
    description: "Start again to sign in and come back to this workspace.",
  },
  config: {
    title: "GitHub isn't set up correctly",
    description: "Ask whoever runs this Derive instance to check its GitHub App.",
  },
  save: {
    title: "Derive couldn't confirm that account",
    description: "GitHub didn't let Derive read its repositories. Try connecting again.",
  },
}

export function GithubSection() {
  const qc = useQueryClient()
  const { data: workspace } = useQuery(workspaceQuery())
  const isAdmin = workspace?.role === "owner"
  const github = useQuery(githubQuery())
  const { github_connected, github_error } = useOneShotParams("github_connected", "github_error")
  const [result] = useState(() => ({ connected: github_connected === "1", error: github_error }))
  const [disconnecting, setDisconnecting] = useState<GithubIntegrationAccount | null>(null)
  const disconnect = useApiMutation({
    mutationFn: (id: string) => api.disconnectGithub(id),
    success: "GitHub account disconnected",
    invalidate: [githubQuery().queryKey, connectionsQuery().queryKey],
  })
  useEffect(() => {
    if (!result.connected && !result.error) return
    void qc.invalidateQueries({ queryKey: githubQuery().queryKey })
    void qc.invalidateQueries({ queryKey: connectionsQuery().queryKey })
    if (result.connected) toast.success("GitHub connected")
  }, [result, qc])

  const data = github.data
  const hasAccounts = !!data?.accounts.length
  const message = result.error
    ? (INSTALL_MESSAGES[result.error] ?? {
        title: "GitHub couldn't be connected",
        description: "Start the connection again.",
      })
    : null

  return (
    <SettingsGroup
      title="GitHub"
      description="Agents work in the repositories you choose on GitHub."
      action={
        isAdmin && data?.available && hasAccounts ? (
          <Button variant="outline" size="sm" data-testid="github-add-account" asChild>
            <a href={CONNECT_URL}>Connect account</a>
          </Button>
        ) : undefined
      }
    >
      {message && (
        <StatusPanel
          layout="inline"
          tone={result.error === "requested" || result.error === "canceled" ? "warning" : "danger"}
          icon={<AlertTriangle aria-hidden />}
          title={message.title}
          description={message.description}
          action={
            isAdmin && result.error !== "canceled" && result.error !== "config" ? (
              <Button variant="outline" size="sm" data-testid="github-install-retry" asChild>
                <a href={CONNECT_URL}>Connect again</a>
              </Button>
            ) : undefined
          }
        />
      )}
      {github.isPending ? (
        <SettingsListSkeleton rows={1} />
      ) : github.isError ? (
        <LoadError
          layout="inline"
          title="Couldn't load GitHub"
          testId="github-retry"
          onRetry={() => github.refetch()}
        />
      ) : !data ? null : !data.available ? (
        <ConnectPrompt
          action={
            data.can_manage_app ? (
              <Button variant="outline" size="sm" data-testid="github-setup" asChild>
                <a href="/settings/github/app/new">Set up GitHub App</a>
              </Button>
            ) : undefined
          }
        >
          GitHub isn't set up on this Derive instance yet.
          {data.can_manage_app ? "" : " Whoever runs it can create the GitHub App."}
        </ConnectPrompt>
      ) : (
        <>
          {data.app_permissions_state === "update_required" && (
            <AppUpdate status={data} canOpen={isAdmin || data.can_manage_app} />
          )}
          {data.accounts.map((account) => (
            <AccountRow
              key={account.installation_id}
              account={account}
              appUnknown={data.app_permissions_state === "unknown"}
              isAdmin={isAdmin}
              onCheck={() => github.refetch()}
              onDisconnect={() => setDisconnecting(account)}
            />
          ))}
          {!hasAccounts && (
            <ConnectPrompt
              action={
                isAdmin ? (
                  <Button variant="outline" size="sm" data-testid="github-connect" asChild>
                    <a href={CONNECT_URL}>Connect GitHub</a>
                  </Button>
                ) : undefined
              }
            >
              Connect a GitHub organization or personal account, then pick which of its repositories
              agents can use.
            </ConnectPrompt>
          )}
          {!isAdmin && <AdminNote can="connect GitHub accounts" />}
        </>
      )}
      <ConfirmDialog
        open={!!disconnecting}
        onOpenChange={(open) => !open && setDisconnecting(null)}
        title={`Disconnect ${disconnecting?.account_login ?? "this GitHub account"}?`}
        description="Agents lose access to its repositories right away. Derive stays installed on GitHub, so you can connect it again later."
        confirmLabel="Disconnect"
        confirmTestId="github-disconnect-confirm"
        onConfirm={() => {
          if (disconnecting) disconnect.mutate(disconnecting.connection_id)
          setDisconnecting(null)
        }}
      />
    </SettingsGroup>
  )
}

/** The App owner on GitHub acts on this, and that is often someone in this workspace. GitHub
 *  decides who may save the change, so the link is offered to anyone who manages GitHub here. */
function AppUpdate({ status, canOpen }: { status: GithubStatus; canOpen: boolean }) {
  return (
    <StatusPanel
      layout="inline"
      tone="warning"
      icon={<AlertTriangle aria-hidden />}
      title="Derive's GitHub App needs new permissions"
      description={`${status.app_owner_login ? `An owner of @${status.app_owner_login}` : "Its owner"} must add them on GitHub, then each connected account accepts them. Current access keeps working until then.`}
      action={
        canOpen && status.app_settings_url ? (
          <Button variant="outline" size="sm" data-testid="github-update-app" asChild>
            <a href={status.app_settings_url}>Review on GitHub</a>
          </Button>
        ) : undefined
      }
    />
  )
}

function AccountRow({
  account,
  appUnknown,
  isAdmin,
  onCheck,
  onDisconnect,
}: {
  account: GithubIntegrationAccount
  appUnknown: boolean
  isAdmin: boolean
  onCheck: () => Promise<unknown>
  onDisconnect: () => void
}) {
  const [open, setOpen] = useState(false)
  const [checking, setChecking] = useState(false)
  const id = account.installation_id
  const login = account.account_login ?? "GitHub account"
  const reconnect = account.state === "needs_reauth"
  const approval = !reconnect && account.permissions_state === "approval_required"
  const unknown = !reconnect && !approval && (appUnknown || account.permissions_state === "unknown")
  const browsable = !reconnect && !unknown
  const listId = `github-repositories-list-${id}`
  const kind =
    account.account_type === "organization"
      ? "Organization"
      : account.account_type === "user"
        ? "Personal account"
        : "GitHub account"
  // A healthy account says nothing about its health; only a state that needs someone does.
  const note = reconnect
    ? "Derive can't reach it. Disconnect, then connect it again."
    : approval
      ? "An owner must approve Derive's new permissions on GitHub."
      : unknown
        ? "GitHub didn't answer, so this account wasn't checked."
        : null

  return (
    <ListRow
      data-testid={`github-account-${id}`}
      leading={
        <AccountMark
          name={login}
          src={
            account.account_login
              ? `https://github.com/${encodeURIComponent(account.account_login)}.png?size=56`
              : null
          }
        />
      }
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{login}</span>
          {(reconnect || approval) && (
            <StatusBadge tone="attention">
              {reconnect ? "Reconnect needed" : "Approval needed"}
            </StatusBadge>
          )}
          {unknown && <StatusBadge tone="muted">Not checked</StatusBadge>}
        </span>
      }
      meta={note ?? kind}
      stackActions
      actions={
        <>
          {browsable && (
            <Button
              variant="ghost"
              size="sm"
              data-testid={`github-repositories-${id}`}
              aria-expanded={open}
              aria-controls={listId}
              onClick={() => setOpen(!open)}
            >
              Repositories
              <ChevronRight
                aria-hidden
                data-icon="inline-end"
                className={cn("transition-transform", open && "rotate-90")}
              />
            </Button>
          )}
          {unknown && (
            <Button
              variant="ghost"
              size="sm"
              data-testid={`github-check-${id}`}
              loading={checking}
              onClick={() => {
                setChecking(true)
                void onCheck().finally(() => setChecking(false))
              }}
            >
              Check again
            </Button>
          )}
          {isAdmin && !reconnect && account.installation_url && (
            <Button variant="ghost" size="sm" data-testid={`github-manage-${id}`} asChild>
              <a href={account.permissions_url ?? account.installation_url}>
                {approval ? "Approve" : "Manage"}
                <ArrowUpRight aria-hidden data-icon="inline-end" />
              </a>
            </Button>
          )}
          {isAdmin && (
            <Button
              variant="destructive-ghost"
              size="sm"
              data-testid={`github-disconnect-${id}`}
              onClick={onDisconnect}
            >
              Disconnect
            </Button>
          )}
        </>
      }
      below={
        open && browsable ? (
          <Repositories id={listId} connectionId={account.connection_id} />
        ) : undefined
      }
    />
  )
}

function Repositories({ id, connectionId }: { id: string; connectionId: string }) {
  const [page, setPage] = useState(1)
  const repos = useQuery(githubRepositoriesQuery(connectionId, page))
  return (
    <div id={id} className="ml-10" data-testid="github-repository-list">
      {repos.isPending ? (
        <SettingsListSkeleton rows={2} trailing={false} />
      ) : repos.isError ? (
        <LoadError
          layout="inline"
          title={repos.error.message}
          testId="github-repositories-retry"
          onRetry={() => repos.refetch()}
        />
      ) : repos.data.repositories.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No repositories chosen yet. Choose them under Manage on GitHub.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <ul className="flex flex-col divide-y divide-border-soft">
            {repos.data.repositories.map((repo) => (
              <li key={repo.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <a
                  href={repo.html_url}
                  className="min-w-0 truncate font-mono text-xs hover:underline hover:underline-offset-4"
                >
                  {repo.full_name}
                </a>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {repo.private ? "Private" : "Public"}
                </span>
              </li>
            ))}
          </ul>
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground tabular-nums">
              {repos.data.total_count === 1
                ? "1 repository"
                : `${repos.data.total_count} repositories`}
            </span>
            {(page > 1 || repos.data.has_more) && (
              <span className="flex gap-1">
                <Button
                  variant="ghost"
                  size="xs"
                  data-testid="github-repositories-previous"
                  disabled={page === 1}
                  onClick={() => setPage(page - 1)}
                >
                  Previous
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  data-testid="github-repositories-next"
                  disabled={!repos.data.has_more}
                  onClick={() => setPage(page + 1)}
                >
                  Next
                </Button>
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
