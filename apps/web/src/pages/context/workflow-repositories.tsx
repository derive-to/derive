import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { api, type Connection, type WorkflowRepository } from "@/api"
import { LoadError } from "@/components/shared/load-error"
import { SectionTitle } from "@/components/shared/section-title"
import { Button } from "@/components/ui/button"
import {
  workflowConfigurationQuery,
  workflowRepositoriesQuery,
  workflowRuntimesQuery,
} from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"

export function WorkflowRepositories({
  contextId,
  connections,
}: {
  contextId: string
  connections: Connection[]
}) {
  const configuration = useQuery({
    ...workflowConfigurationQuery(contextId),
    refetchOnMount: "always",
  })
  const qc = useQueryClient()
  const [connectionId, setConnectionId] = useState("")
  const [repository, setRepository] = useState("")
  const [access, setAccess] = useState<"read" | "write">("read")
  const [page, setPage] = useState(1)
  const catalog = useQuery({
    ...workflowRepositoriesQuery(contextId, connectionId, page),
    enabled: !!connectionId && !!configuration.data?.can_manage_repositories,
  })
  const key = workflowConfigurationQuery(contextId).queryKey
  const save = useApiMutation({
    mutationFn: async (
      repositories: Pick<WorkflowRepository, "connection_id" | "repository" | "access">[],
    ) => {
      const revision = configuration.data?.repository_revision
      if (revision === undefined) throw new Error("Reload repository access before saving")
      await qc.cancelQueries({ queryKey: key, exact: true })
      const saved = await api.saveWorkflowRepositories(contextId, { repositories, revision })
      qc.setQueryData(
        key,
        (current: typeof configuration.data) => current && { ...current, ...saved },
      )
      setRepository("")
      setAccess("read")
      return saved
    },
    invalidate: [key, workflowRuntimesQuery().queryKey],
    success: "Repository access updated",
  })
  if (configuration.isError)
    return (
      <LoadError
        title="Couldn’t load repository access"
        testId="workflow-repositories-retry"
        onRetry={() => void configuration.refetch()}
      />
    )
  if (!configuration.data || !configuration.isFetchedAfterMount)
    return <p className="text-sm text-muted-foreground">Loading repository access…</p>
  const grants = configuration.data.repositories
  const selected = grants.map(({ connection_id, repository, access }) => ({
    connection_id,
    repository,
    access,
  }))
  const canManage = configuration.data.can_manage_repositories
  const installations = connections.filter(
    (c) => c.kind === "github_app" && c.scope === "workspace" && c.status === "active",
  )
  return (
    <section className="flex flex-col gap-3">
      <SectionTitle>Repositories</SectionTitle>
      <p className="text-xs text-muted-foreground">
        The agent can clone these repositories into its saved workspace. Read access lets it fetch
        code. Write access also lets it push changes and open pull requests, subject to GitHub’s
        branch rules.
      </p>
      {grants.map((grant) => (
        <div key={grant.repository_id} className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-sm">{grant.repository}</p>
            {canManage ? (
              <select
                aria-label={`Access to ${grant.repository}`}
                className="rounded-md border bg-background p-1 text-xs"
                data-testid={`workflow-repository-access-${grant.repository_id}`}
                value={grant.access}
                disabled={save.isPending}
                onChange={(e) =>
                  save.mutate(
                    selected.map((r) =>
                      r.repository === grant.repository
                        ? { ...r, access: e.target.value === "write" ? "write" : "read" }
                        : r,
                    ),
                  )
                }
              >
                <option value="read">Read only</option>
                <option value="write">Read and write</option>
              </select>
            ) : (
              <p className="text-xs text-muted-foreground">
                {grant.access === "write" ? "Read and write" : "Read only"}
              </p>
            )}
          </div>
          {canManage && (
            <Button
              size="sm"
              variant="ghost"
              data-testid={`workflow-repository-remove-${grant.repository_id}`}
              disabled={save.isPending}
              onClick={() => save.mutate(selected.filter((r) => r.repository !== grant.repository))}
            >
              Remove
            </Button>
          )}
        </div>
      ))}
      {!canManage ? (
        <p className="text-xs text-muted-foreground">
          A workspace owner can change repository access.
        </p>
      ) : (
        <>
          <label className="flex flex-col gap-1 text-sm">
            GitHub connection
            <select
              className="rounded-md border bg-background p-2 text-sm"
              data-testid="workflow-repository-connection"
              value={connectionId}
              disabled={save.isPending}
              onChange={(e) => {
                setConnectionId(e.target.value)
                setPage(1)
                setRepository("")
              }}
            >
              <option value="">Choose a GitHub installation</option>
              {installations.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.scopes_label || c.toolkit}
                </option>
              ))}
            </select>
          </label>
          {connectionId && (
            <>
              {catalog.isError ? (
                <LoadError
                  title="Couldn’t load repositories"
                  testId="workflow-repository-catalog-retry"
                  onRetry={() => void catalog.refetch()}
                />
              ) : (
                <label className="flex flex-col gap-1 text-sm">
                  Repository
                  <select
                    className="rounded-md border bg-background p-2 text-sm"
                    data-testid="workflow-repository-picker"
                    value={repository}
                    disabled={save.isPending || catalog.isFetching}
                    onChange={(e) => setRepository(e.target.value)}
                  >
                    <option value="">
                      {catalog.isFetching ? "Loading repositories…" : "Choose a repository"}
                    </option>
                    {catalog.data?.repositories
                      .filter((r) => !grants.some((g) => g.repository_id === r.id))
                      .map((r) => (
                        <option key={r.id} value={r.repository}>
                          {r.repository}
                        </option>
                      ))}
                  </select>
                </label>
              )}
              {(page > 1 || catalog.data?.next_page) && (
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    data-testid="workflow-repository-previous"
                    disabled={page === 1 || catalog.isFetching || save.isPending}
                    onClick={() => {
                      setPage(page - 1)
                      setRepository("")
                    }}
                  >
                    Previous
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    data-testid="workflow-repository-next"
                    disabled={!catalog.data?.next_page || catalog.isFetching || save.isPending}
                    onClick={() => {
                      setPage(page + 1)
                      setRepository("")
                    }}
                  >
                    Next
                  </Button>
                </div>
              )}
              <label className="flex flex-col gap-1 text-sm">
                Access
                <select
                  className="rounded-md border bg-background p-2 text-sm"
                  data-testid="workflow-repository-permission"
                  value={access}
                  disabled={save.isPending}
                  onChange={(e) => setAccess(e.target.value === "write" ? "write" : "read")}
                >
                  <option value="read">Read only</option>
                  <option value="write">Read and write</option>
                </select>
              </label>
              <Button
                data-testid="workflow-repository-add"
                disabled={!repository || save.isPending || grants.length >= 10}
                onClick={() =>
                  save.mutate([...selected, { connection_id: connectionId, repository, access }])
                }
              >
                {save.isPending ? "Saving…" : "Add repository"}
              </Button>
            </>
          )}
          <Link
            to="/settings/$section"
            params={{ section: "github" }}
            data-testid="workflow-repository-settings"
            className="text-sm text-primary underline"
          >
            Manage GitHub connection
          </Link>
        </>
      )}
      {!!grants.length && (
        <p className="text-xs text-muted-foreground">
          GitHub tools are limited to these repositories for cloud runs. Removing access stops new
          credentials; a credential already issued can remain valid for up to one hour.
        </p>
      )}
    </section>
  )
}
