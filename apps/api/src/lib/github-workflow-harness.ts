import type {
  GithubWorkflowAutomationAction,
  MetaStore,
  WorkflowRunRecord,
  WorkflowRunStatus,
} from "@derive/core"
import { createRemoteJWKSet, type JWTPayload, type JWTVerifyGetKey, jwtVerify } from "jose"
import {
  type GithubActionReceipt,
  githubActionReceipt,
  validateGithubWorkflowAutomation,
} from "./automation-action"
import { executeHttpTool } from "./broker"
import { signWorkToken } from "./run-token"

export const GITHUB_WORKFLOW_AUDIENCE = "derive-graph-runner"
export const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com"
const GITHUB_OIDC_JWKS = createRemoteJWKSet(new URL(`${GITHUB_OIDC_ISSUER}/.well-known/jwks`))
// A GitHub-hosted job can legitimately sit queued before it starts. The nonce is not
// sufficient authority on its own: exchange still requires the exact signed run identity.
const EXCHANGE_TTL_MS = 24 * 60 * 60_000
// The CLI permits one harness to run for six hours. Leave a small receipt window after that
// ceiling instead of reusing the 20-minute managed-executor token lifecycle.
const WORKFLOW_CAPABILITY_TTL_MS = 6 * 60 * 60_000 + 15 * 60_000

const githubExternalRunId = (repository: string, runId: string): string => `${repository}#${runId}`

export interface GithubWorkflowExecution {
  kind: "github_actions"
  connection_id: string
  installation_id: string
  repository: string
  workflow: string
  ref: string
  nonce_hash: string
  exchange_expires_at: string
  github_run_id: string | null
  github_run_url: string | null
  github_run_attempt: number | null
  oidc_subject: string | null
  capability_expires_at: string | null
  exchanged_at: string | null
  github_status: string | null
  github_conclusion: string | null
  settled_at: string | null
  last_error: string | null
}

export interface GithubOidcIdentity {
  subject: string
  repository: string
  workflowRef: string
  ref: string
  runId: string
  runAttempt: number
}

export interface PublicGithubWorkflowExecution {
  kind: "github_actions"
  repository: string
  workflow: string
  ref: string
  github_run_id: string | null
  github_run_attempt: number | null
  github_status: string | null
  github_conclusion: string | null
  exchanged_at: string | null
  settled_at: string | null
  last_error: string | null
}

export class GithubWorkflowHarnessError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 401 | 409 | 502 = 400,
  ) {
    super(message)
    this.name = "GithubWorkflowHarnessError"
  }
}

const positiveId = (value: unknown): string | null => {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value)
  if (typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value)) return value
  return null
}

const positiveAttempt = (value: unknown): number | null => {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : 0
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

const isString = (value: unknown): value is string => typeof value === "string" && value.length > 0

export const parseGithubWorkflowExecution = (
  value: string | null,
): GithubWorkflowExecution | null => {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as Partial<GithubWorkflowExecution>
    if (
      parsed.kind !== "github_actions" ||
      !isString(parsed.connection_id) ||
      !positiveId(parsed.installation_id) ||
      !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(parsed.repository ?? "") ||
      !/^derive-[A-Za-z0-9_.-]{1,193}\.ya?ml$/.test(parsed.workflow ?? "") ||
      !isString(parsed.ref) ||
      !/^[a-f0-9]{64}$/.test(parsed.nonce_hash ?? "") ||
      !isString(parsed.exchange_expires_at) ||
      !Number.isFinite(Date.parse(parsed.exchange_expires_at ?? "")) ||
      (parsed.capability_expires_at !== null &&
        parsed.capability_expires_at !== undefined &&
        (!isString(parsed.capability_expires_at) ||
          !Number.isFinite(Date.parse(parsed.capability_expires_at))))
    )
      return null
    const nonceHash = parsed.nonce_hash
    const exchangeExpiresAt = parsed.exchange_expires_at
    if (!nonceHash || !exchangeExpiresAt) return null
    return {
      kind: "github_actions",
      connection_id: parsed.connection_id,
      installation_id: parsed.installation_id as string,
      repository: parsed.repository as string,
      workflow: parsed.workflow as string,
      ref: parsed.ref,
      nonce_hash: nonceHash,
      exchange_expires_at: exchangeExpiresAt,
      github_run_id: positiveId(parsed.github_run_id),
      github_run_url: isString(parsed.github_run_url) ? parsed.github_run_url : null,
      github_run_attempt: positiveAttempt(parsed.github_run_attempt),
      oidc_subject: isString(parsed.oidc_subject) ? parsed.oidc_subject : null,
      capability_expires_at: isString(parsed.capability_expires_at)
        ? parsed.capability_expires_at
        : null,
      exchanged_at: isString(parsed.exchanged_at) ? parsed.exchanged_at : null,
      github_status: isString(parsed.github_status) ? parsed.github_status : null,
      github_conclusion: isString(parsed.github_conclusion) ? parsed.github_conclusion : null,
      settled_at: isString(parsed.settled_at) ? parsed.settled_at : null,
      last_error: isString(parsed.last_error) ? parsed.last_error : null,
    }
  } catch {
    return null
  }
}

/** Browser-safe run receipt. The assignment hash, installation id, connection id, OIDC
 * subject, and capability timestamps stay server-side; none are needed to explain a run. */
export const publicGithubWorkflowExecution = (
  value: string | null,
): PublicGithubWorkflowExecution | null => {
  const parsed = parseGithubWorkflowExecution(value)
  if (!parsed) return null
  return {
    kind: parsed.kind,
    repository: parsed.repository,
    workflow: parsed.workflow,
    ref: parsed.ref,
    github_run_id: parsed.github_run_id,
    github_run_attempt: parsed.github_run_attempt,
    github_status: parsed.github_status,
    github_conclusion: parsed.github_conclusion,
    exchanged_at: parsed.exchanged_at,
    settled_at: parsed.settled_at,
    last_error: parsed.last_error,
  }
}

export const sha256Hex = async (value: string): Promise<string> => {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

export const newGithubWorkflowExecution = async (input: {
  connectionId: string
  installationId: string
  owner: string
  repo: string
  workflow: string
  ref: string
  nonce: string
  now?: Date
}): Promise<GithubWorkflowExecution> => {
  const now = input.now ?? new Date()
  return {
    kind: "github_actions",
    connection_id: input.connectionId,
    installation_id: input.installationId,
    repository: `${input.owner}/${input.repo}`,
    workflow: input.workflow,
    ref: input.ref,
    nonce_hash: await sha256Hex(input.nonce),
    exchange_expires_at: new Date(now.getTime() + EXCHANGE_TTL_MS).toISOString(),
    github_run_id: null,
    github_run_url: null,
    github_run_attempt: null,
    oidc_subject: null,
    capability_expires_at: null,
    exchanged_at: null,
    github_status: null,
    github_conclusion: null,
    settled_at: null,
    last_error: null,
  }
}

const workflowAction = (
  assignment: GithubWorkflowExecution,
  runId: string,
  nonce: string,
): GithubWorkflowAutomationAction => {
  const [owner, repo] = assignment.repository.split("/") as [string, string]
  return {
    kind: "github_workflow",
    owner,
    repo,
    workflow: assignment.workflow,
    ref: assignment.ref,
    inputs: { derive_run_id: runId, derive_exchange_nonce: nonce },
  }
}

export const dispatchGithubWorkflowRun = async (input: {
  meta: MetaStore
  run: WorkflowRunRecord
  assignment: GithubWorkflowExecution
  nonce: string
  encryptionKey: string
  now?: Date
}): Promise<WorkflowRunRecord> => {
  const action = workflowAction(input.assignment, input.run.id, input.nonce)
  const connection = await validateGithubWorkflowAutomation(
    input.meta,
    input.run.org_id,
    [input.assignment.connection_id],
    action,
  )
  if (connection.broker_ref !== input.assignment.installation_id)
    throw new GithubWorkflowHarnessError("the GitHub installation assignment changed", 409)
  try {
    const result = await executeHttpTool(
      input.meta,
      connection,
      "github.post",
      {
        path: `/repos/${action.owner}/${action.repo}/actions/workflows/${action.workflow}/dispatches`,
        body: { ref: action.ref, inputs: action.inputs, return_run_details: true },
      },
      input.encryptionKey,
    )
    if (result.status < 200 || result.status >= 300)
      throw new GithubWorkflowHarnessError(
        `GitHub refused the workflow dispatch (${result.status})`,
        502,
      )
    const receipt = githubActionReceipt(action, result.body)
    if (!receipt)
      throw new GithubWorkflowHarnessError("GitHub did not return a workflow run id", 502)
    const assigned: GithubWorkflowExecution = {
      ...input.assignment,
      github_run_id: receipt.run_id,
      github_run_url: receipt.url,
      github_status: "dispatched",
    }
    const at = (input.now ?? new Date()).toISOString()
    const transitioned = await input.meta.transitionWorkflowRun(
      input.run.id,
      input.run.org_id,
      { status: input.run.status, stateRevision: input.run.state_revision },
      {
        status: "dispatched",
        at,
        externalExecution: JSON.stringify(assigned),
        externalRunId: githubExternalRunId(assigned.repository, receipt.run_id),
      },
    )
    if (!transitioned)
      throw new GithubWorkflowHarnessError("the workflow run changed during dispatch", 409)
    return transitioned
  } catch (error) {
    const message = error instanceof Error ? error.message : "GitHub workflow dispatch failed"
    const failed: GithubWorkflowExecution = { ...input.assignment, last_error: message }
    await input.meta.transitionWorkflowRun(
      input.run.id,
      input.run.org_id,
      { status: input.run.status, stateRevision: input.run.state_revision },
      {
        status: "failed",
        at: (input.now ?? new Date()).toISOString(),
        externalExecution: JSON.stringify(failed),
      },
    )
    throw error instanceof GithubWorkflowHarnessError
      ? error
      : new GithubWorkflowHarnessError(message, 502)
  }
}

const expectedRefs = (ref: string): readonly string[] =>
  ref.startsWith("refs/") ? [ref] : [`refs/heads/${ref}`, `refs/tags/${ref}`]

export const validateGithubOidcClaims = (
  claims: JWTPayload,
  assignment: GithubWorkflowExecution,
): GithubOidcIdentity => {
  const repository = claims.repository
  const ref = claims.ref
  const workflowRef = claims.workflow_ref
  const runId = positiveId(claims.run_id)
  const runAttempt = positiveAttempt(claims.run_attempt)
  const subject = claims.sub
  const allowedRefs = expectedRefs(assignment.ref)
  const expectedWorkflowRef = `${assignment.repository}/.github/workflows/${assignment.workflow}@${String(ref)}`
  if (
    repository !== assignment.repository ||
    !isString(ref) ||
    !allowedRefs.includes(ref) ||
    workflowRef !== expectedWorkflowRef ||
    !runId ||
    runId !== assignment.github_run_id ||
    !runAttempt ||
    runAttempt !== (assignment.github_run_attempt ?? 1) ||
    !isString(subject) ||
    claims.event_name !== "workflow_dispatch"
  )
    throw new GithubWorkflowHarnessError("GitHub Actions identity does not match this run", 401)
  return {
    subject,
    repository,
    workflowRef,
    ref,
    runId,
    runAttempt,
  }
}

export const verifyGithubOidc = async (
  token: string,
  assignment: GithubWorkflowExecution,
  options: { now?: Date; key?: JWTVerifyGetKey } = {},
): Promise<GithubOidcIdentity> => {
  const verified = await jwtVerify(token, options.key ?? GITHUB_OIDC_JWKS, {
    issuer: GITHUB_OIDC_ISSUER,
    audience: GITHUB_WORKFLOW_AUDIENCE,
    currentDate: options.now,
    clockTolerance: 5,
    maxTokenAge: "10m",
  })
  return validateGithubOidcClaims(verified.payload, assignment)
}

export const exchangeGithubWorkflowCapability = async (input: {
  meta: MetaStore
  runId: string
  nonce: string
  oidcToken: string
  encryptionKey: string
  instruction: (run: WorkflowRunRecord) => Promise<string> | string
  baseUrl: string
  now?: Date
  verify?: typeof verifyGithubOidc
}): Promise<{ token: string; instruction: string; expiresAt: string; mcpUrl: string }> => {
  const now = input.now ?? new Date()
  const run = await input.meta.getWorkflowRunById(input.runId)
  const assignment = parseGithubWorkflowExecution(run?.external_execution ?? null)
  if (
    !run ||
    !assignment ||
    !run.assigned_agent_id ||
    run.requested_execution !== "github_actions" ||
    (run.status !== "dispatched" && run.status !== "running" && run.status !== "waiting")
  )
    throw new GithubWorkflowHarnessError("GitHub workflow exchange is not available", 409)
  if (now.getTime() >= Date.parse(assignment.exchange_expires_at))
    throw new GithubWorkflowHarnessError("GitHub workflow exchange expired", 401)
  if (!(await timingSafeHashMatch(input.nonce, assignment.nonce_hash)))
    throw new GithubWorkflowHarnessError("GitHub workflow exchange is not authorized", 401)
  const connection = await input.meta.getConnection(assignment.connection_id)
  if (
    !connection ||
    connection.org_id !== run.org_id ||
    connection.status !== "active" ||
    connection.kind !== "github_app" ||
    connection.toolkit !== "github" ||
    connection.broker_ref !== assignment.installation_id
  )
    throw new GithubWorkflowHarnessError("GitHub workflow exchange is not authorized", 401)
  let identity: GithubOidcIdentity
  try {
    identity = await (input.verify ?? verifyGithubOidc)(input.oidcToken, assignment, { now })
  } catch (error) {
    if (error instanceof GithubWorkflowHarnessError) throw error
    throw new GithubWorkflowHarnessError("GitHub workflow identity is invalid", 401)
  }
  const priorIdentity =
    assignment.github_run_attempt && assignment.oidc_subject
      ? `${assignment.github_run_id}:${assignment.github_run_attempt}:${assignment.oidc_subject}`
      : null
  const currentIdentity = `${identity.runId}:${identity.runAttempt}:${identity.subject}`
  if (priorIdentity && priorIdentity !== currentIdentity)
    throw new GithubWorkflowHarnessError("GitHub workflow exchange was already used", 409)
  let expiresAt = assignment.capability_expires_at
    ? new Date(assignment.capability_expires_at)
    : new Date(now.getTime() + WORKFLOW_CAPABILITY_TTL_MS)
  if (now.getTime() >= expiresAt.getTime())
    throw new GithubWorkflowHarnessError("GitHub workflow capability expired", 401)
  let activeRun = run
  if (run.status === "dispatched") {
    const exchanged: GithubWorkflowExecution = {
      ...assignment,
      github_run_attempt: identity.runAttempt,
      oidc_subject: identity.subject,
      capability_expires_at: expiresAt.toISOString(),
      exchanged_at: now.toISOString(),
      github_status: "in_progress",
    }
    const transitioned = await input.meta.transitionWorkflowRun(
      run.id,
      run.org_id,
      { status: run.status, stateRevision: run.state_revision },
      {
        status: "running",
        at: now.toISOString(),
        actualExecution: "github_actions",
        executorId: run.assigned_agent_id,
        externalExecution: JSON.stringify(exchanged),
      },
    )
    if (transitioned) activeRun = transitioned
    else {
      const raced = await input.meta.getWorkflowRun(run.id, run.org_id)
      const racedAssignment = parseGithubWorkflowExecution(raced?.external_execution ?? null)
      const racedIdentity =
        racedAssignment?.github_run_attempt && racedAssignment.oidc_subject
          ? `${racedAssignment.github_run_id}:${racedAssignment.github_run_attempt}:${racedAssignment.oidc_subject}`
          : null
      if (
        raced?.status !== "running" ||
        racedIdentity !== currentIdentity ||
        !racedAssignment?.capability_expires_at
      )
        throw new GithubWorkflowHarnessError("the workflow run changed during exchange", 409)
      expiresAt = new Date(racedAssignment.capability_expires_at)
      activeRun = raced
    }
  } else {
    if (!priorIdentity || !assignment.capability_expires_at)
      throw new GithubWorkflowHarnessError("GitHub workflow exchange is inconsistent", 409)
  }
  return {
    token: await signWorkToken(
      "workflow",
      input.encryptionKey,
      activeRun.id,
      activeRun.assigned_agent_id as string,
      activeRun.org_id,
      expiresAt.getTime(),
    ),
    instruction: await input.instruction(activeRun),
    expiresAt: expiresAt.toISOString(),
    mcpUrl: new URL("/mcp", input.baseUrl).toString(),
  }
}

const timingSafeHashMatch = async (value: string, expected: string): Promise<boolean> => {
  const actual = await sha256Hex(value)
  if (actual.length !== expected.length) return false
  let mismatch = 0
  for (let index = 0; index < actual.length; index += 1)
    mismatch |= actual.charCodeAt(index) ^ expected.charCodeAt(index)
  return mismatch === 0
}

const terminalForConclusion = (
  conclusion: string,
): Extract<WorkflowRunStatus, "failed" | "cancelled" | "timed_out"> => {
  if (conclusion === "cancelled") return "cancelled"
  if (conclusion === "timed_out") return "timed_out"
  return "failed"
}

export const reconcileGithubWorkflowRun = async (input: {
  meta: MetaStore
  installationId: string
  repository: string
  workflowPath: string
  runId: string
  runAttempt: number
  status: string
  conclusion: string
  url: string
  at?: Date
}): Promise<WorkflowRunRecord | null> => {
  const externalRunId = githubExternalRunId(input.repository, input.runId)
  const run = await input.meta.getWorkflowRunByExternalRunId(externalRunId)
  const assignment = parseGithubWorkflowExecution(run?.external_execution ?? null)
  if (
    !run ||
    !assignment ||
    assignment.installation_id !== input.installationId ||
    assignment.repository !== input.repository ||
    `.github/workflows/${assignment.workflow}` !== input.workflowPath ||
    assignment.github_run_id !== input.runId ||
    input.runAttempt !== (assignment.github_run_attempt ?? 1) ||
    assignment.github_run_url !== input.url
  )
    return null
  if (assignment.settled_at)
    return assignment.github_run_attempt === input.runAttempt &&
      assignment.github_status === input.status &&
      assignment.github_conclusion === input.conclusion
      ? run
      : null
  const at = (input.at ?? new Date()).toISOString()
  const succeededAndSettled = input.conclusion === "success" && run.status === "succeeded"
  const conclusion =
    input.conclusion === "success" && !succeededAndSettled ? "failure" : input.conclusion
  const receipt: GithubWorkflowExecution = {
    ...assignment,
    github_run_attempt: input.runAttempt,
    github_status: input.status,
    github_conclusion: input.conclusion,
    settled_at: at,
    last_error:
      input.conclusion === "success" && !succeededAndSettled
        ? "GitHub job succeeded without a terminal successful Derive graph receipt"
        : assignment.last_error,
  }
  if (
    succeededAndSettled ||
    run.status === "failed" ||
    run.status === "cancelled" ||
    run.status === "timed_out"
  )
    return input.meta.setWorkflowRunExternalReceipt(
      run.id,
      run.org_id,
      externalRunId,
      JSON.stringify(receipt),
      at,
    )
  if (run.status === "succeeded")
    return input.meta.overrideSuccessfulWorkflowRunFromExternal(
      run.id,
      run.org_id,
      externalRunId,
      terminalForConclusion(conclusion),
      JSON.stringify(receipt),
      at,
    )
  const target = terminalForConclusion(conclusion)
  const attempts = await input.meta.listWorkflowStepAttempts(run.id, run.org_id)
  for (const attempt of attempts) {
    if (
      attempt.status === "succeeded" ||
      attempt.status === "failed" ||
      attempt.status === "cancelled"
    )
      continue
    await input.meta.transitionWorkflowStepAttempt(
      attempt.id,
      run.id,
      run.org_id,
      { status: attempt.status, stateRevision: attempt.state_revision },
      {
        status: target === "cancelled" ? "cancelled" : "failed",
        at,
        error: receipt.last_error ?? `GitHub workflow concluded ${input.conclusion}`,
      },
    )
  }
  const current = await input.meta.getWorkflowRun(run.id, run.org_id)
  if (!current) return null
  if (current.status === "succeeded")
    return input.meta.overrideSuccessfulWorkflowRunFromExternal(
      current.id,
      current.org_id,
      externalRunId,
      target,
      JSON.stringify(receipt),
      at,
    )
  return input.meta.transitionWorkflowRun(
    current.id,
    current.org_id,
    { status: current.status, stateRevision: current.state_revision },
    {
      status: target,
      at,
      ...(current.actual_execution && current.executor_id
        ? { actualExecution: current.actual_execution, executorId: current.executor_id }
        : {}),
      externalExecution: JSON.stringify(receipt),
    },
  )
}

export type { GithubActionReceipt }
