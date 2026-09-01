import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { CheckCircle2, Copy, ExternalLink, GitBranch, ShieldCheck } from "lucide-react"
import { type ReactNode, useMemo, useState } from "react"
import { ApiError, api, type DirUser } from "@/api"
import { Eyebrow } from "@/components/shared/section-eyebrow"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { toast } from "@/components/ui/sonner"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { copyText } from "@/lib/clipboard"
import { automationConnectionsQuery, githubQuery, workspaceSettingsQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import { cn } from "@/lib/utils"
import {
  githubRepositoryError,
  githubRepositoryParts,
  githubWorkflowFileError,
  githubWorkflowRefError,
} from "@/pages/workflows/automation-format"
import { AgentMenu, ALREADY_QUEUED, queuedFor } from "./ask-agent"
import type { AgentTarget } from "./types"
import { workflowGithubStarterAdapter } from "./workflow-github-presentation"

type Harness = "agent" | "github"

const Field = ({
  label,
  hint,
  error,
  children,
}: {
  label: string
  hint?: string
  error?: string | null
  children: ReactNode
}) => (
  <div className="flex min-w-0 flex-col gap-1.5">
    <Eyebrow>{label}</Eyebrow>
    {children}
    {hint ? <p className="text-2xs leading-relaxed text-muted-foreground">{hint}</p> : null}
    {error ? (
      <p className="text-xs text-destructive" role="alert">
        {error}
      </p>
    ) : null}
  </div>
)

const SetupCheck = ({ ready, children }: { ready: boolean; children: ReactNode }) => (
  <li className="flex min-w-0 gap-2 text-xs leading-relaxed text-muted-foreground">
    <span
      aria-hidden="true"
      className={cn(
        "mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border",
        ready ? "border-success/30 bg-success/10 text-success" : "border-border bg-background",
      )}
    >
      {ready ? <CheckCircle2 className="size-3" /> : null}
    </span>
    <span className="min-w-0 break-words">{children}</span>
  </li>
)

export function WorkflowRunDialog({
  shortId,
  diagramId,
  agents,
  open,
  onOpenChange,
}: {
  shortId: string
  diagramId: string
  agents: DirUser[]
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const settings = useQuery({ ...workspaceSettingsQuery(), enabled: open })
  const githubEnabled = settings.data?.automateBeta === true
  const connections = useQuery({
    ...automationConnectionsQuery(),
    enabled: open && githubEnabled,
  })
  const github = useQuery({ ...githubQuery(), enabled: open && githubEnabled })
  const githubConnections = useMemo(
    () =>
      (connections.data ?? []).filter(
        (connection) =>
          connection.status === "active" &&
          connection.kind === "github_app" &&
          connection.toolkit === "github",
      ),
    [connections.data],
  )
  const [harness, setHarness] = useState<Harness>("agent")
  const [connectionId, setConnectionId] = useState("")
  const [repository, setRepository] = useState("")
  const [workflow, setWorkflow] = useState("")
  const [ref, setRef] = useState("main")
  const selectedConnectionId =
    connectionId || (githubConnections.length === 1 ? (githubConnections[0]?.id ?? "") : "")
  const repositoryParts = githubRepositoryParts(repository)
  const repositoryError = githubRepositoryError(repository)
  const workflowError = githubWorkflowFileError(workflow)
  const refError = githubWorkflowRefError(ref)
  const githubReady =
    !!repositoryParts &&
    !workflowError &&
    !refError &&
    selectedConnectionId !== "" &&
    !connections.isPending &&
    !github.isPending
  const starterAdapter = workflowGithubStarterAdapter()

  const { data, error, isError, refetch } = useQuery({
    queryKey: ["workflow-run-prompt", shortId, diagramId] as const,
    queryFn: () => api.workflowRunPrompt(shortId, diagramId),
    enabled: open,
  })
  const previewChanged = error instanceof ApiError && error.code === "needsChanges"
  const handoffReady = !!data && !isError
  const run = useApiMutation<{ runId: string; prompt: string; requestId?: string }, AgentTarget>({
    mutationFn: (agent) => api.runWorkflow(shortId, { agentId: agent.id, diagramId }),
    success: (_result, agent) => {
      void queryClient.invalidateQueries({ queryKey: ["workflow-runs", shortId, diagramId] })
      queuedFor("Workflow", agent.name)
    },
    errorToast: false,
    onError: (runError) => {
      if (runError instanceof ApiError && runError.code === "alreadyQueued") toast(ALREADY_QUEUED)
      else if (runError instanceof ApiError && runError.code === "needsChanges")
        toast.error("This workflow needs changes before it can run.")
      else toast.error("Couldn’t hand off this workflow. Try again.")
    },
    onSuccess: () => onOpenChange(false),
  })
  const copyRun = useApiMutation<{ runId: string; prompt: string }, void>({
    mutationFn: () => api.runWorkflow(shortId, { diagramId, delivery: "copy" }),
    success: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["workflow-runs", shortId, diagramId] })
      void copyText(result.prompt, { success: "Prompt copied. Paste it into your agent." })
    },
    errorToast: false,
    onError: () => toast.error("Couldn’t start this workflow. Try again."),
  })
  const githubRun = useApiMutation<
    { runId: string; prompt?: string; github?: { runId: string; url: string } },
    void
  >({
    mutationFn: () => {
      const target = githubRepositoryParts(repository)
      if (!target) throw new Error("Invalid repository")
      return api.runWorkflow(shortId, {
        diagramId,
        delivery: "github",
        github: {
          connectionId: selectedConnectionId,
          owner: target.owner,
          repo: target.repo,
          workflow: workflow.trim(),
          ref: ref.trim(),
        },
      })
    },
    success: () => "GitHub Actions dispatched",
    invalidate: [["workflow-runs", shortId, diagramId]],
    errorToast: false,
    onError: (runError) => {
      if (runError instanceof ApiError && runError.code === "needsChanges")
        toast.error("This workflow changed and needs a fresh Preview.")
      else if (runError instanceof ApiError && runError.code === "sourcePolicy")
        toast.error("That adapter is not allowed on the repository’s default branch.")
      else toast.error("GitHub Actions did not start. Check the setup and try again.")
    },
    onSuccess: () => onOpenChange(false),
  })

  const githubSetupPending = connections.isPending || github.isPending
  const githubSetupError = connections.isError || github.isError
  const noGithubInstallation = !githubSetupPending && githubConnections.length === 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-none overflow-y-auto sm:max-h-[calc(100dvh-2rem)] sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Run now</DialogTitle>
          <DialogDescription>
            Choose one harness for this exact, version-pinned graph. Derive keeps its Context
            sessions, approvals, artifacts, and receipts.
          </DialogDescription>
        </DialogHeader>
        <div
          className={cn(
            "rounded-lg border px-3 py-2 text-xs",
            handoffReady
              ? "border-success/25 bg-success/5 text-success"
              : isError
                ? "border-destructive/25 bg-destructive/5 text-destructive"
                : "border-border bg-muted/30 text-muted-foreground",
          )}
        >
          {handoffReady
            ? "Preview passed. Nothing starts until you choose a harness below."
            : previewChanged
              ? "Preview is out of date. Return to the workflow and review it again."
              : isError
                ? "Run unavailable."
                : "Checking the latest Preview…"}
        </div>

        {githubEnabled ? (
          <Tabs value={harness} onValueChange={(value) => setHarness(value as Harness)}>
            <TabsList className="grid !h-auto w-full grid-cols-2 items-stretch gap-1">
              <TabsTrigger
                value="agent"
                data-testid="workflow-harness-agent"
                className="h-auto min-w-0 justify-start px-3 py-2.5"
              >
                Connected Agent or copy
              </TabsTrigger>
              <TabsTrigger
                value="github"
                data-testid="workflow-harness-github"
                className="h-auto min-w-0 justify-start px-3 py-2.5"
              >
                GitHub Actions
              </TabsTrigger>
            </TabsList>
            <TabsContent value="agent" className="mt-3 grid min-w-0 gap-3">
              <div className="rounded-md border border-border">
                <Eyebrow
                  as="div"
                  className="flex items-center justify-between border-b border-border-soft py-1 pr-1 pl-3"
                >
                  Run instruction
                  <Button
                    variant="ghost"
                    size="sm"
                    data-testid="workflow-run-copy"
                    disabled={!data || copyRun.isPending}
                    onClick={() => copyRun.mutate()}
                  >
                    {copyRun.isPending ? "Starting…" : "Start & copy"}
                  </Button>
                </Eyebrow>
                {isError ? (
                  <div className="flex flex-wrap items-center gap-2 px-3 py-3 text-sm text-muted-foreground">
                    {previewChanged
                      ? "The workflow changed and needs a fresh Preview."
                      : "Couldn’t compose the handoff."}
                    <Button
                      variant="ghost"
                      size="sm"
                      data-testid="workflow-run-retry"
                      onClick={() => (previewChanged ? onOpenChange(false) : refetch())}
                    >
                      {previewChanged ? "Close" : "Retry"}
                    </Button>
                  </div>
                ) : (
                  <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-xs text-muted-foreground">
                    {data?.prompt ?? "…"}
                  </pre>
                )}
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Start & copy creates a fresh run for a local harness. A connected Agent receives the
                same instruction in its pull inbox and starts when it checks in.
              </p>
              <DialogFooter>
                <AgentMenu
                  agents={agents}
                  menuLabel="Run with which agent?"
                  testidPrefix="workflow-run-agent"
                  onPick={(agent) => run.mutate(agent)}
                  trigger={({ sole, onClick }) => (
                    <Button
                      data-testid="workflow-run-send"
                      disabled={run.isPending || !data}
                      onClick={onClick}
                    >
                      {sole ? `Run with ${sole.name}` : "Run with my agent"}
                    </Button>
                  )}
                />
              </DialogFooter>
            </TabsContent>
            <TabsContent value="github" className="mt-3 grid min-w-0 gap-4">
              <div
                className="rounded-lg border border-border bg-muted/20 p-3 sm:p-4"
                data-testid="workflow-github-setup"
              >
                <div className="flex min-w-0 gap-3">
                  <span className="grid size-9 shrink-0 place-items-center rounded-lg border bg-background">
                    <GitBranch className="size-4" aria-hidden="true" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm font-medium text-foreground">One-time setup</p>
                      {noGithubInstallation ? (
                        <Button
                          variant="outline"
                          size="sm"
                          asChild
                          data-testid="workflow-github-open-integrations"
                        >
                          <Link
                            to="/settings/$section"
                            params={{ section: "integrations" }}
                            target="_blank"
                          >
                            Open Integrations <ExternalLink className="size-3.5" aria-hidden />
                          </Link>
                        </Button>
                      ) : null}
                    </div>
                    {githubSetupError ? (
                      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-destructive">
                        Couldn’t confirm this workspace’s GitHub setup.
                        <Button
                          size="sm"
                          variant="ghost"
                          data-testid="workflow-github-setup-retry"
                          onClick={() =>
                            void Promise.all([connections.refetch(), github.refetch()])
                          }
                        >
                          Retry
                        </Button>
                      </div>
                    ) : (
                      <ul className="mt-3 grid gap-2">
                        <SetupCheck ready={selectedConnectionId !== ""}>
                          {githubSetupPending
                            ? "Checking the Derive GitHub App…"
                            : noGithubInstallation
                              ? "Connect the Derive GitHub App and grant only the repositories this workspace may run."
                              : "A repository-scoped GitHub App installation is available."}
                        </SetupCheck>
                        <SetupCheck ready={!workflowError}>
                          Add a reviewed workflow_dispatch adapter named derive-*.yml on the
                          repository’s default branch.
                        </SetupCheck>
                        <SetupCheck ready={githubReady}>
                          Grant id-token: write and let the repository workflow start its approved
                          agent environment. Derive needs no provider or model credentials.
                        </SetupCheck>
                      </ul>
                    )}
                  </div>
                </div>
              </div>

              <div className="grid min-w-0 gap-4 rounded-lg border border-border bg-card p-3 sm:grid-cols-2 sm:p-4">
                <div className="min-w-0 sm:col-span-2">
                  <Field
                    label="GitHub installation"
                    hint="The App installation is the authorization boundary for repositories."
                  >
                    <Select
                      value={selectedConnectionId}
                      onValueChange={setConnectionId}
                      disabled={githubSetupPending || githubConnections.length === 0}
                    >
                      <SelectTrigger
                        className="w-full min-w-0"
                        data-testid="workflow-github-connection"
                        aria-label="GitHub installation"
                      >
                        <SelectValue
                          placeholder={
                            githubSetupPending
                              ? "Checking GitHub…"
                              : "Select a GitHub App installation"
                          }
                        />
                      </SelectTrigger>
                      <SelectContent>
                        {githubConnections.map((connection) => (
                          <SelectItem key={connection.id} value={connection.id}>
                            {connection.scopes_label ?? "GitHub App installation"}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                </div>
                <Field
                  label="Repository"
                  hint="GitHub owner/name — not a URL."
                  error={repository ? repositoryError : null}
                >
                  <Input
                    data-testid="workflow-github-repository"
                    aria-label="Repository"
                    aria-invalid={repository ? repositoryError !== null : undefined}
                    placeholder="owner/repository"
                    value={repository}
                    maxLength={201}
                    spellCheck={false}
                    autoCapitalize="none"
                    onChange={(event) => setRepository(event.target.value)}
                  />
                </Field>
                <Field
                  label="Git ref"
                  hint="Branch or tag to run. The adapter file itself must be on the default branch."
                  error={ref ? refError : null}
                >
                  <Input
                    data-testid="workflow-github-ref"
                    aria-label="Git ref"
                    aria-invalid={ref ? refError !== null : undefined}
                    placeholder="main"
                    value={ref}
                    maxLength={1_024}
                    spellCheck={false}
                    autoCapitalize="none"
                    onChange={(event) => setRef(event.target.value)}
                  />
                </Field>
                <Field
                  label="Adapter workflow"
                  hint="Only deliberately exposed derive-*.yml or derive-*.yaml files can run."
                  error={workflow ? workflowError : null}
                >
                  <Input
                    data-testid="workflow-github-workflow"
                    aria-label="Adapter workflow"
                    aria-invalid={workflow ? workflowError !== null : undefined}
                    placeholder="derive-graph-runner.yml"
                    value={workflow}
                    maxLength={200}
                    spellCheck={false}
                    autoCapitalize="none"
                    onChange={(event) => setWorkflow(event.target.value)}
                  />
                </Field>
              </div>

              <div className="flex min-w-0 gap-3 rounded-lg border border-primary/20 bg-primary/5 p-3">
                <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
                <div className="min-w-0 text-xs leading-relaxed text-muted-foreground">
                  <p className="font-medium text-foreground">
                    The repository workflow owns the agent
                  </p>
                  <p className="mt-0.5">
                    GitHub receives only a bounded run ID and one-time exchange nonce. The job uses
                    GitHub OIDC to fetch the pinned instruction and a short-lived run capability.
                    The workflow provisions and authenticates its agent. Derive never calls its
                    provider API or receives its sandbox, login, or model credentials.
                  </p>
                </div>
              </div>

              <details className="min-w-0 overflow-hidden rounded-lg border border-border bg-card">
                <summary className="cursor-pointer px-3 py-2.5 text-xs font-medium text-foreground">
                  Copy runner-neutral adapter
                </summary>
                <div className="min-w-0 border-t border-border-soft">
                  <div className="flex items-center justify-between gap-2 px-3 py-2">
                    <span className="min-w-0 break-words text-2xs text-muted-foreground">
                      Save as .github/workflows/derive-graph-runner.yml on the default branch.
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      className="shrink-0"
                      data-testid="workflow-github-copy-adapter"
                      onClick={() =>
                        void copyText(starterAdapter, { success: "Starter adapter copied." })
                      }
                    >
                      <Copy className="size-3.5" aria-hidden="true" /> Copy
                    </Button>
                  </div>
                  <pre className="max-h-60 max-w-full overflow-x-auto border-t border-border-soft bg-muted/25 p-3 font-mono text-2xs text-muted-foreground">
                    <code>{starterAdapter}</code>
                  </pre>
                </div>
              </details>

              <DialogFooter>
                <Button
                  data-testid="workflow-github-run"
                  disabled={!handoffReady || !githubReady || githubRun.isPending}
                  onClick={() => githubRun.mutate()}
                >
                  {githubRun.isPending ? "Dispatching…" : "Run with GitHub Actions"}
                </Button>
              </DialogFooter>
            </TabsContent>
          </Tabs>
        ) : (
          <div className="grid min-w-0 gap-3">
            <div className="rounded-md border border-border">
              <Eyebrow
                as="div"
                className="flex items-center justify-between border-b border-border-soft py-1 pr-1 pl-3"
              >
                Run instruction
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid="workflow-run-copy"
                  disabled={!data || copyRun.isPending}
                  onClick={() => copyRun.mutate()}
                >
                  {copyRun.isPending ? "Starting…" : "Start & copy"}
                </Button>
              </Eyebrow>
              <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-xs text-muted-foreground">
                {data?.prompt ?? "…"}
              </pre>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              GitHub Actions is available only when this workspace explicitly enables Automate.
            </p>
            <DialogFooter>
              <AgentMenu
                agents={agents}
                menuLabel="Run with which agent?"
                testidPrefix="workflow-run-agent"
                onPick={(agent) => run.mutate(agent)}
                trigger={({ sole, onClick }) => (
                  <Button
                    data-testid="workflow-run-send"
                    disabled={run.isPending || !data}
                    onClick={onClick}
                  >
                    {sole ? `Run with ${sole.name}` : "Run with my agent"}
                  </Button>
                )}
              />
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
