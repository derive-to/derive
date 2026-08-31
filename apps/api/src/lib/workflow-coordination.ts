import {
  type ArtifactRecord,
  type ContextRecord,
  type MetaStore,
  newId,
  type SessionRecord,
  type WorkflowExecutionLane,
  type WorkflowNodeDefinition,
  type WorkflowRouteDefinition,
  type WorkflowRunRecord,
  type WorkflowRunStatus,
  type WorkflowStepAttemptRecord,
  type WorkflowStepAttemptStatus,
  workflowStatusIsTerminal,
} from "@derive/core"
import { parseLinkedWorkflowFacts } from "./workflow-facts"

export interface WorkflowUseRef {
  run_id: string
  node_id: string
  attempt: number
}

export interface WorkflowReceipt extends WorkflowUseRef {
  status: Extract<WorkflowStepAttemptStatus, "succeeded" | "failed" | "cancelled">
  decision?: unknown
  selected_routes?: string[]
  route_basis?: string
  output?: unknown
  error?: string
  finish_run?: Extract<WorkflowRunStatus, "succeeded" | "failed" | "cancelled">
}

interface PinnedNode {
  run: WorkflowRunRecord
  node: WorkflowNodeDefinition
  routes: WorkflowRouteDefinition[]
  entry: string
  attemptLimit: number | null
}

const pinnedNode = async (
  meta: MetaStore,
  ref: WorkflowUseRef,
  orgId: string,
): Promise<PinnedNode | string> => {
  const run = await meta.getWorkflowRun(ref.run_id, orgId)
  if (!run) return "No such workflow run in this workspace."
  const facts = parseLinkedWorkflowFacts(
    await meta.getVersionData(run.workflow_artifact_id, run.workflow_version),
  )
  const diagram = facts.definition?.diagrams.find((candidate) => candidate.id === run.diagram_id)
  const node = diagram?.nodes.find((candidate) => candidate.id === ref.node_id)
  if (!diagram || !node)
    return "The pinned workflow definition does not contain this diagram and node."
  const attemptLimits = (diagram.loops ?? [])
    .filter((loop) => loop.nodes.includes(node.id))
    .map((loop) => loop.stop.max_attempts)
  return {
    run,
    node,
    routes: diagram.routes.filter((route) => route.from === node.id),
    entry: diagram.entry,
    attemptLimit: attemptLimits.length > 0 ? Math.min(...attemptLimits) : null,
  }
}

const selectedRouteTargets = (attempt: WorkflowStepAttemptRecord): string[] => {
  if (attempt.status !== "succeeded" || !attempt.selected_routes) return []
  try {
    const routes: unknown = JSON.parse(attempt.selected_routes)
    return Array.isArray(routes) && routes.every((route) => typeof route === "string") ? routes : []
  } catch {
    return []
  }
}

const selectedRouteIncludes = (attempt: WorkflowStepAttemptRecord, nodeId: string): boolean =>
  selectedRouteTargets(attempt).includes(nodeId)

const attemptFor = (
  attempts: readonly WorkflowStepAttemptRecord[],
  ref: WorkflowUseRef,
): WorkflowStepAttemptRecord | undefined =>
  attempts.find((attempt) => attempt.node_id === ref.node_id && attempt.attempt === ref.attempt)

const workflowAttemptStatusForSession = (session: SessionRecord): WorkflowStepAttemptStatus => {
  switch (session.state) {
    case "working":
      return "running"
    case "failed":
      return "failed"
    case "closed":
      return "cancelled"
    default:
      return "waiting"
  }
}

const validateHumanEffectGate = (
  pinned: PinnedNode,
  ref: WorkflowUseRef,
  attempts: readonly WorkflowStepAttemptRecord[],
): string | null => {
  const effects = (pinned.node.effects ?? []).filter((effect) => effect.gate === "human")
  const approvalRefs = new Set(
    effects
      .map((effect) => effect.approval_ref)
      .filter((approvalRef): approvalRef is string => !!approvalRef),
  )
  for (const approvalRef of approvalRefs) {
    const approvals = attempts.filter(
      (attempt) =>
        attempt.node_id === approvalRef &&
        attempt.status === "succeeded" &&
        selectedRouteIncludes(attempt, pinned.node.id),
    ).length
    if (approvals >= ref.attempt) continue
    const approvalReusable = effects
      .filter((effect) => effect.approval_ref === approvalRef)
      .every((effect) => !!effect.idempotency)
    if (approvals > 0 && approvalReusable) continue
    if (approvals > 0)
      return `Workflow node "${pinned.node.id}" attempt ${ref.attempt} cannot reuse approval from "${approvalRef}" because its human-gated effect has no idempotency contract. Start a new run for fresh approval.`
    return `Workflow node "${pinned.node.id}" requires approval from "${approvalRef}" before its effect can run.`
  }
  return null
}

const validateNewAttempt = (
  pinned: PinnedNode,
  ref: WorkflowUseRef,
  attempts: readonly WorkflowStepAttemptRecord[],
): string | null => {
  if (pinned.attemptLimit && ref.attempt > pinned.attemptLimit)
    return `Workflow node "${pinned.node.id}" is limited to ${pinned.attemptLimit} attempts.`
  const prior = attempts
    .filter((attempt) => attempt.node_id === pinned.node.id)
    .sort((left, right) => right.attempt - left.attempt)[0]
  const expectedAttempt = (prior?.attempt ?? 0) + 1
  if (ref.attempt !== expectedAttempt)
    return `Workflow node "${pinned.node.id}" must use attempt ${expectedAttempt}.`
  if (prior) {
    if (!workflowStatusIsTerminal(prior.status))
      return `Workflow node "${pinned.node.id}" already has an active attempt.`
    if (prior.status === "failed" || prior.status === "cancelled")
      return validateHumanEffectGate(pinned, ref, attempts)
  }
  if (attempts.length === 0)
    return pinned.node.id === pinned.entry
      ? validateHumanEffectGate(pinned, ref, attempts)
      : `Workflow diagram must begin at entry node "${pinned.entry}".`
  if (!attempts.some((attempt) => selectedRouteIncludes(attempt, pinned.node.id)))
    return `Workflow node "${pinned.node.id}" has not been selected by a completed route.`
  return validateHumanEffectGate(pinned, ref, attempts)
}

const validateContextTarget = (
  pinned: PinnedNode,
  context: ContextRecord,
  manifest: ArtifactRecord,
  orgId: string,
): string | null => {
  if (context.org_id !== orgId || manifest.org_id !== orgId)
    return "The workflow run and context must be in the same workspace."
  if (pinned.node.kind !== "context")
    return `Workflow node "${pinned.node.id}" is not a context node.`
  if (manifest.id !== context.manifest_artifact_id)
    return `Context "${context.name}" has a different manifest.`
  if (pinned.node.context_ref !== context.id && pinned.node.context_ref !== context.name)
    return `Workflow node "${pinned.node.id}" requires context "${pinned.node.context_ref}", not "${context.name}".`
  return null
}

/** Validate a workflow/context pairing before creating a session visible to a runner. */
export const prepareWorkflowContextUse = async (args: {
  meta: MetaStore
  ref: WorkflowUseRef
  orgId: string
  context: ContextRecord
  manifest: ArtifactRecord
}): Promise<undefined | string> => {
  const pinned = await pinnedNode(args.meta, args.ref, args.orgId)
  if (typeof pinned === "string") return pinned
  if (workflowStatusIsTerminal(pinned.run.status))
    return `Workflow run ${pinned.run.id} is already ${pinned.run.status}.`
  const invalidTarget = validateContextTarget(pinned, args.context, args.manifest, args.orgId)
  if (invalidTarget) return invalidTarget
  const attempts = await args.meta.listWorkflowStepAttempts(pinned.run.id, args.orgId)
  if (attemptFor(attempts, args.ref)) return undefined
  return validateNewAttempt(pinned, args.ref, attempts) ?? undefined
}

export const claimWorkflowRun = async (
  meta: MetaStore,
  run: WorkflowRunRecord,
  executorId: string,
  at: string,
  lane: WorkflowExecutionLane = "local",
): Promise<WorkflowRunRecord | string> => {
  if (workflowStatusIsTerminal(run.status))
    return `Workflow run ${run.id} is already ${run.status}.`
  if (run.executor_id && run.executor_id !== executorId)
    return "This workflow run is already claimed by another executor."
  if (run.actual_execution && run.actual_execution !== lane)
    return "This workflow run is already claimed by another execution lane."
  if (run.status === "running") return run
  const claimed = await meta.transitionWorkflowRun(
    run.id,
    run.org_id,
    { status: run.status, stateRevision: run.state_revision },
    {
      status: "running",
      at,
      actualExecution: lane,
      executorId,
    },
  )
  return claimed ?? "The workflow run changed while this executor was claiming it; read it again."
}

export const bindWorkflowContextSession = async (args: {
  meta: MetaStore
  ref: WorkflowUseRef
  orgId: string
  context: ContextRecord
  manifest: ArtifactRecord
  session: SessionRecord
  executorId: string
  executionLane?: WorkflowExecutionLane
  at: string
}): Promise<WorkflowStepAttemptRecord | string> => {
  const sessionAttempt = await args.meta.getWorkflowStepAttemptBySession(
    args.session.id,
    args.orgId,
  )
  if (sessionAttempt)
    return sessionAttempt.workflow_run_id === args.ref.run_id &&
      sessionAttempt.node_id === args.ref.node_id &&
      sessionAttempt.attempt === args.ref.attempt
      ? sessionAttempt
      : "This context session is already bound to another workflow attempt."
  const pinned = await pinnedNode(args.meta, args.ref, args.orgId)
  if (typeof pinned === "string") return pinned
  const invalidTarget = validateContextTarget(pinned, args.context, args.manifest, args.orgId)
  if (invalidTarget) return invalidTarget
  if (args.session.org_id !== args.orgId || args.session.context_id !== args.context.id)
    return "This session does not belong to the workflow context."
  if (!args.session.context_version)
    return `Context "${args.context.name}" did not pin a manifest version.`
  const manifestVersion = await args.meta.getVersion(args.manifest.id, args.session.context_version)
  if (!manifestVersion) return `Context "${args.context.name}" has no readable manifest version.`
  let attempts = await args.meta.listWorkflowStepAttempts(pinned.run.id, args.orgId)
  let existing = attemptFor(attempts, args.ref)
  if (existing)
    return existing.session_id === args.session.id
      ? existing
      : "This workflow node attempt is already bound to another context session."
  const invalidAttempt = validateNewAttempt(pinned, args.ref, attempts)
  if (invalidAttempt) return invalidAttempt
  const claimed = await claimWorkflowRun(
    args.meta,
    pinned.run,
    args.executorId,
    args.at,
    args.executionLane,
  )
  if (typeof claimed === "string") return claimed
  attempts = await args.meta.listWorkflowStepAttempts(claimed.id, args.orgId)
  existing = attemptFor(attempts, args.ref)
  if (existing)
    return existing.session_id === args.session.id
      ? existing
      : "This workflow node attempt is already bound to another context session."
  const racedAttempt = validateNewAttempt(pinned, args.ref, attempts)
  if (racedAttempt) return racedAttempt
  let created: WorkflowStepAttemptRecord
  try {
    created = await args.meta.createWorkflowStepAttempt(args.orgId, {
      id: newId("wsa"),
      workflow_run_id: claimed.id,
      node_id: pinned.node.id,
      attempt: args.ref.attempt,
      kind: "context",
      context_id: args.context.id,
      context_manifest_artifact_id: args.manifest.id,
      context_version: manifestVersion.n,
      context_blob_key: manifestVersion.blob_key,
      context_content_type: manifestVersion.content_type,
      session_id: args.session.id,
      created_at: args.at,
    })
  } catch (error) {
    const winner = (await args.meta.listWorkflowStepAttempts(claimed.id, args.orgId)).find(
      (attempt) => attempt.node_id === pinned.node.id && attempt.attempt === args.ref.attempt,
    )
    if (winner?.session_id === args.session.id) return winner
    if (winner) return "This workflow node attempt is already bound to another context session."
    throw error
  }
  const staged = await args.meta.transitionWorkflowStepAttempt(
    created.id,
    created.workflow_run_id,
    args.orgId,
    { status: "queued", stateRevision: created.state_revision },
    {
      status: workflowAttemptStatusForSession(args.session),
      at: args.at,
      sessionId: args.session.id,
      ...(args.session.result_artifact_id
        ? { resultArtifactId: args.session.result_artifact_id }
        : {}),
    },
  )
  if (staged) return staged
  const winner = await args.meta.getWorkflowStepAttemptBySession(args.session.id, args.orgId)
  return winner ?? "The workflow attempt changed before its context session could be attached."
}

export const syncWorkflowContextSession = async (
  meta: MetaStore,
  session: SessionRecord,
): Promise<void> => {
  const target = workflowAttemptStatusForSession(session)
  for (let tryNumber = 0; tryNumber < 2; tryNumber += 1) {
    const attempt = await meta.getWorkflowStepAttemptBySession(session.id, session.org_id)
    if (!attempt || workflowStatusIsTerminal(attempt.status) || attempt.status === target) return
    const updated = await meta.transitionWorkflowStepAttempt(
      attempt.id,
      attempt.workflow_run_id,
      session.org_id,
      { status: attempt.status, stateRevision: attempt.state_revision },
      {
        status: target,
        at: session.updated_at ?? new Date().toISOString(),
        sessionId: session.id,
        ...(session.result_artifact_id ? { resultArtifactId: session.result_artifact_id } : {}),
      },
    )
    if (updated) return
  }
}

const encoded = (value: unknown): string | undefined =>
  value === undefined ? undefined : JSON.stringify(value)

const sameTargets = (actual: readonly string[], expected: readonly string[]): boolean =>
  actual.length === expected.length &&
  new Set(actual).size === actual.length &&
  actual.every((target) => expected.includes(target))

const receiptFields = (
  receipt: WorkflowReceipt,
  resultArtifactId?: string | null,
): {
  decision?: string
  selectedRoutes?: string
  routeBasis?: string
  resultArtifactId?: string
  output?: string
  error?: string
} => ({
  decision: encoded(receipt.decision),
  selectedRoutes: encoded(receipt.selected_routes),
  routeBasis: receipt.route_basis,
  ...(resultArtifactId ? { resultArtifactId } : {}),
  output: encoded(receipt.output),
  error: receipt.error,
})

const terminalReceiptMatches = (
  attempt: WorkflowStepAttemptRecord,
  receipt: WorkflowReceipt,
  resultArtifactId?: string | null,
): boolean => {
  if (attempt.status !== receipt.status) return false
  const fields = receiptFields(receipt, resultArtifactId)
  return (
    (fields.decision === undefined || fields.decision === attempt.decision) &&
    (fields.selectedRoutes === undefined || fields.selectedRoutes === attempt.selected_routes) &&
    (fields.routeBasis === undefined || fields.routeBasis === attempt.route_basis) &&
    (fields.resultArtifactId === undefined ||
      fields.resultArtifactId === attempt.result_artifact_id) &&
    (fields.output === undefined || fields.output === attempt.output) &&
    (fields.error === undefined || fields.error === attempt.error)
  )
}

const successfulRunBlocker = (attempts: readonly WorkflowStepAttemptRecord[]): string | null => {
  const latestByNode = new Map<string, WorkflowStepAttemptRecord>()
  for (const attempt of attempts) {
    const latest = latestByNode.get(attempt.node_id)
    if (!latest || attempt.attempt > latest.attempt) latestByNode.set(attempt.node_id, attempt)
  }
  const selectedTargets = new Set(attempts.flatMap(selectedRouteTargets))
  for (const target of selectedTargets) {
    const latest = latestByNode.get(target)
    if (!latest) return `Selected workflow node "${target}" has not started.`
    if (latest.status !== "succeeded")
      return `Selected workflow node "${target}" has not succeeded.`
  }
  return null
}

export const recordWorkflowReceipt = async (args: {
  meta: MetaStore
  receipt: WorkflowReceipt
  orgId: string
  executorId: string
  executionLane?: WorkflowExecutionLane
  at: string
}): Promise<{ run: WorkflowRunRecord; attempt: WorkflowStepAttemptRecord } | string> => {
  const pinned = await pinnedNode(args.meta, args.receipt, args.orgId)
  if (typeof pinned === "string") return pinned
  const routeTargets = new Set(pinned.routes.map((route) => route.to))
  const selectedRoutes = args.receipt.selected_routes ?? []
  if (selectedRoutes.some((target) => !routeTargets.has(target)))
    return `A selected route is not authored from workflow node "${pinned.node.id}".`
  if (new Set(selectedRoutes).size !== selectedRoutes.length)
    return "A workflow receipt cannot select the same route more than once."
  if (args.receipt.finish_run && args.receipt.finish_run !== args.receipt.status)
    return "The final run status must match the final node-attempt status."
  if (args.receipt.status !== "succeeded" && selectedRoutes.length > 0)
    return "A failed or cancelled workflow attempt cannot select a next route."
  if (
    args.receipt.status === "succeeded" &&
    !pinned.node.terminal &&
    pinned.node.kind !== "terminal" &&
    pinned.routes.length > 0 &&
    selectedRoutes.length === 0
  )
    return `Workflow node "${pinned.node.id}" must record its selected authored route.`
  if (
    args.receipt.status === "succeeded" &&
    pinned.node.kind === "context" &&
    pinned.node.routing === "one" &&
    selectedRoutes.length !== 1
  )
    return `Workflow node "${pinned.node.id}" must select exactly one authored route.`
  if (
    args.receipt.status === "succeeded" &&
    pinned.node.kind === "context" &&
    pinned.node.routing === "all" &&
    !sameTargets(
      selectedRoutes,
      pinned.routes.map((route) => route.to),
    )
  )
    return `Workflow node "${pinned.node.id}" must select every authored route.`
  if (
    args.receipt.status === "succeeded" &&
    pinned.node.kind === "context" &&
    pinned.routes.length === 1 &&
    !sameTargets(selectedRoutes, [pinned.routes[0]?.to ?? ""])
  )
    return `Workflow node "${pinned.node.id}" must select its authored route.`
  if (
    args.receipt.finish_run === "succeeded" &&
    !pinned.node.terminal &&
    pinned.node.kind !== "terminal"
  )
    return `Workflow node "${pinned.node.id}" is not terminal and cannot succeed the run.`
  if (
    pinned.node.kind === "human" &&
    args.receipt.status === "succeeded" &&
    (typeof args.receipt.decision !== "string" ||
      !pinned.node.options?.includes(args.receipt.decision))
  )
    return `The decision must be one of: ${pinned.node.options?.join(", ") ?? "the authored options"}.`
  if (pinned.node.kind === "human" && typeof args.receipt.decision === "string") {
    const expectedTargets = pinned.routes
      .filter((route) => route.when === args.receipt.decision)
      .map((route) => route.to)
    if (!sameTargets(selectedRoutes, expectedTargets))
      return `Decision "${args.receipt.decision}" must select: ${expectedTargets.join(", ")}.`
  }

  let attempts = await args.meta.listWorkflowStepAttempts(pinned.run.id, args.orgId)
  let attempt = attemptFor(attempts, args.receipt)
  if (!attempt) {
    if (pinned.node.kind === "context")
      return "Open the context session with this workflow run before recording its receipt."
    const invalidAttempt = validateNewAttempt(pinned, args.receipt, attempts)
    if (invalidAttempt) return invalidAttempt
  }
  let contextSession: SessionRecord | null = null
  if (pinned.node.kind === "context") {
    contextSession = attempt?.session_id ? await args.meta.getSession(attempt.session_id) : null
    const requiredState =
      args.receipt.status === "succeeded"
        ? "answered"
        : args.receipt.status === "failed"
          ? "failed"
          : "closed"
    if (contextSession?.state !== requiredState)
      return `A context attempt can become ${args.receipt.status} only after its session becomes ${requiredState}.`
  }
  const resultArtifactId = contextSession?.result_artifact_id
  if (workflowStatusIsTerminal(pinned.run.status)) {
    if (
      attempt &&
      terminalReceiptMatches(attempt, args.receipt, resultArtifactId) &&
      (!args.receipt.finish_run || args.receipt.finish_run === pinned.run.status)
    )
      return { run: pinned.run, attempt }
    return `Workflow run ${pinned.run.id} is already ${pinned.run.status}.`
  }
  const claimed = await claimWorkflowRun(
    args.meta,
    pinned.run,
    args.executorId,
    args.at,
    args.executionLane,
  )
  if (typeof claimed === "string") return claimed
  if (!attempt) {
    const attemptKind = pinned.node.kind === "human" ? "human" : "terminal"
    try {
      attempt = await args.meta.createWorkflowStepAttempt(args.orgId, {
        id: newId("wsa"),
        workflow_run_id: claimed.id,
        node_id: pinned.node.id,
        attempt: args.receipt.attempt,
        kind: attemptKind,
        created_at: args.at,
      })
    } catch (error) {
      attempts = await args.meta.listWorkflowStepAttempts(claimed.id, args.orgId)
      attempt = attemptFor(attempts, args.receipt)
      if (!attempt) throw error
    }
  }
  if (attempt.kind !== pinned.node.kind)
    return "The workflow attempt kind does not match the pinned node."
  if (attempt.status === "queued") {
    const staged = await args.meta.transitionWorkflowStepAttempt(
      attempt.id,
      attempt.workflow_run_id,
      args.orgId,
      { status: "queued", stateRevision: attempt.state_revision },
      { status: pinned.node.kind === "human" ? "waiting" : "running", at: args.at },
    )
    if (staged) attempt = staged
    else {
      attempts = await args.meta.listWorkflowStepAttempts(claimed.id, args.orgId)
      const current = attemptFor(attempts, args.receipt)
      if (!current) return "The workflow attempt changed while its receipt was being recorded."
      attempt = current
    }
  }
  let settled: WorkflowStepAttemptRecord | null
  if (workflowStatusIsTerminal(attempt.status)) {
    settled = terminalReceiptMatches(attempt, args.receipt, resultArtifactId) ? attempt : null
  } else {
    settled = await args.meta.transitionWorkflowStepAttempt(
      attempt.id,
      attempt.workflow_run_id,
      args.orgId,
      { status: attempt.status, stateRevision: attempt.state_revision },
      {
        status: args.receipt.status,
        at: args.at,
        ...receiptFields(args.receipt, resultArtifactId),
      },
    )
    if (!settled) {
      attempts = await args.meta.listWorkflowStepAttempts(claimed.id, args.orgId)
      const current = attemptFor(attempts, args.receipt)
      settled =
        current && terminalReceiptMatches(current, args.receipt, resultArtifactId) ? current : null
    }
  }
  if (!settled) return "This workflow attempt is already settled with a different receipt."

  let run = claimed
  if (args.receipt.finish_run) {
    attempts = await args.meta.listWorkflowStepAttempts(run.id, args.orgId)
    if (
      attempts.some(
        (candidate) =>
          candidate.id !== settled.id &&
          candidate.status !== "succeeded" &&
          candidate.status !== "failed" &&
          candidate.status !== "cancelled",
      )
    )
      return "A workflow run cannot finish while another node attempt is still active."
    if (args.receipt.finish_run === "succeeded") {
      const incomplete = successfulRunBlocker(attempts)
      if (incomplete) return incomplete
    }
    const finished = await args.meta.transitionWorkflowRun(
      run.id,
      run.org_id,
      { status: run.status, stateRevision: run.state_revision },
      {
        status: args.receipt.finish_run,
        at: args.at,
        actualExecution: run.actual_execution ?? "local",
        executorId: args.executorId,
      },
    )
    if (!finished) {
      const current = await args.meta.getWorkflowRun(run.id, args.orgId)
      if (current?.status === args.receipt.finish_run) return { run: current, attempt: settled }
      return "The workflow run changed while its final receipt was being recorded."
    }
    run = finished
  }
  return { run, attempt: settled }
}
