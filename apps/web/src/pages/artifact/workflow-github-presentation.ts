import type { WorkflowRunSummary } from "@/api"

export interface WorkflowGithubReceipt {
  repository: string
  workflow: string
  ref: string
  provider: "codex"
  runId: string | null
  runUrl: string | null
  runAttempt: number | null
  githubStatus: string | null
  githubConclusion: string | null
  exchangedAt: string | null
  settledAt: string | null
  error: string | null
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

const stringValue = (value: Record<string, unknown>, ...keys: string[]): string | null => {
  for (const key of keys) {
    if (typeof value[key] === "string" && value[key]) return value[key] as string
  }
  return null
}

const positiveInteger = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value
  if (typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value)) {
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) ? parsed : null
  }
  return null
}

/** Parse the externally settled execution receipt without trusting a persisted URL. GitHub links
 * are reconstructed from the validated assignment and run id, matching direct Automate receipts. */
export const workflowGithubReceipt = (run: WorkflowRunSummary): WorkflowGithubReceipt | null => {
  const summary = run as WorkflowRunSummary & {
    externalExecution?: unknown
    external_execution?: unknown
  }
  let raw = summary.externalExecution ?? summary.external_execution
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw) as unknown
    } catch {
      return null
    }
  }
  const external = record(raw)
  if (!external) return null
  const github = record(external.github) ?? external
  const owner = stringValue(github, "owner")
  const repo = stringValue(github, "repo")
  const explicitRepository = stringValue(github, "repository")
  const repository = explicitRepository ?? (owner && repo ? `${owner}/${repo}` : null)
  const workflow = stringValue(github, "workflow")
  const ref = stringValue(github, "ref")
  if (
    !repository ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    !workflow ||
    !/^derive-[A-Za-z0-9_.-]+\.ya?ml$/.test(workflow) ||
    !ref
  )
    return null
  const runId = positiveInteger(
    github.github_run_id ?? github.githubRunId ?? github.run_id ?? github.runId,
  )
  return {
    repository,
    workflow,
    ref,
    provider: "codex",
    runId: runId === null ? null : String(runId),
    runUrl:
      runId === null ? null : `https://github.com/${repository}/actions/runs/${String(runId)}`,
    runAttempt: positiveInteger(github.github_run_attempt ?? github.githubRunAttempt),
    githubStatus: stringValue(github, "github_status", "githubStatus"),
    githubConclusion: stringValue(github, "github_conclusion", "githubConclusion"),
    exchangedAt: stringValue(github, "exchanged_at", "exchangedAt"),
    settledAt: stringValue(github, "settled_at", "settledAt"),
    error: stringValue(github, "last_error", "lastError", "error"),
  }
}

export const workflowGithubProviderLabel = (): string => "Codex"

export const workflowGithubStarterAdapter = (): string => `name: Derive graph runner

on:
  workflow_dispatch:
    inputs:
      derive_run_id:
        description: Version-pinned Derive workflow run
        required: true
        type: string
      derive_exchange_nonce:
        description: One-time OIDC exchange nonce
        required: true
        type: string

permissions:
  contents: read
  id-token: write

jobs:
  run:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    steps:
      - name: Check out the repository
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - name: Install pinned harness
        run: npm install --global "@derive-to/cli@0.6.0" "@openai/codex@0.151.0"
      - name: Run the assigned graph
        run: derive workflow run
        env:
          DERIVE_SERVER: https://derive.to
          DERIVE_WORKFLOW_RUN_ID: \${{ inputs.derive_run_id }}
          DERIVE_EXCHANGE_NONCE: \${{ inputs.derive_exchange_nonce }}
          OPENAI_API_KEY: \${{ secrets.OPENAI_API_KEY }}
`
