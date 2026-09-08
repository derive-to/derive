import type { WorkflowPublishReceiptRecord, WorkflowVersionPublish } from "@derive/core"
import { newId, PublishError } from "@derive/core"

type Value = string | number | null
export interface WorkflowPublishStatement {
  text: string
  values: Value[]
}

// One ordered, portable batch. SQLite runs it in a synchronous transaction; D1
// uses batch(); PostgreSQL locks the parent run and target before executing it.
// Every write after the claim requires this call's unique receipt id. A retry
// with the same key therefore cannot append a version or change ownership.
export const workflowPublishStatements = (
  input: WorkflowVersionPublish,
): WorkflowPublishStatement[] => {
  const r = { ...input.receipt, id: newId("wpr") }
  const v = input.version
  const create = "create" in input.target ? input.target.create : null
  const artifactId = create?.id ?? ("artifact_id" in input.target ? input.target.artifact_id : "")
  const shortId = create?.short_id ?? ("short_id" in input.target ? input.target.short_id : "")
  if (
    !r.id ||
    !r.org_id ||
    !r.workflow_run_id ||
    !r.node_id.trim() ||
    !r.dedupe_key.trim() ||
    r.dedupe_key.length > 200 ||
    !Number.isSafeInteger(r.attempt) ||
    r.attempt < 1
  )
    throw new Error("Workflow publish requires a valid attempt and retry key")
  if (!/^[a-f0-9]{64}$/.test(r.request_hash))
    throw new Error("Workflow publish requires a request hash")
  if (
    create &&
    (create.org_id !== r.org_id || !("owner_id" in input.target) || !input.target.owner_id)
  )
    throw new Error("Workflow publish requires an owner in the target workspace")
  const statements: WorkflowPublishStatement[] = []
  const insert = (
    table: string,
    row: Record<string, Value>,
    suffix: string,
    values: Value[] = [],
  ) => {
    const entries = Object.entries(row)
    statements.push({
      text: `INSERT INTO ${table} (${entries.map(([key]) => key).join(", ")}) SELECT ${entries.map(() => "?").join(", ")} ${suffix}`,
      values: [...entries.map(([, value]) => value), ...values],
    })
  }
  const claim = "EXISTS (SELECT 1 FROM workflow_publish_receipt WHERE id = ?)"
  insert(
    "workflow_publish_receipt",
    {
      id: r.id,
      org_id: r.org_id,
      workflow_run_id: r.workflow_run_id,
      node_id: r.node_id,
      attempt: r.attempt,
      dedupe_key: r.dedupe_key,
      request_hash: r.request_hash,
      artifact_id: artifactId,
      artifact_short_id: shortId,
      artifact_version: 0,
      version_id: v.id,
      activity_id: r.activity_id,
      role: r.role,
      created_at: r.created_at,
    },
    "FROM workflow_run WHERE id = ? AND org_id = ? ON CONFLICT (workflow_run_id, node_id, attempt, dedupe_key) DO NOTHING",
    [r.workflow_run_id, r.org_id],
  )
  if (create) {
    insert(
      "artifact",
      {
        id: create.id,
        short_id: create.short_id,
        org_id: create.org_id,
        slug: create.slug,
        title: create.title,
        workspace_access: create.workspace_access ?? "none",
        link_role: create.link_role ?? "none",
        listed: create.listed ?? "none",
        password_hash: create.password_hash ?? null,
        kind: create.kind,
        spa: create.spa,
        expires_at: create.expires_at ?? null,
        derived_from: create.derived_from ?? null,
        created_at: r.created_at,
      },
      `WHERE ${claim}`,
      [r.id],
    )
    insert(
      "artifact_member",
      {
        id: `am_${r.id}`,
        artifact_id: create.id,
        user_id: "owner_id" in input.target ? input.target.owner_id : "",
        role: "owner",
        created_at: r.created_at,
      },
      `WHERE ${claim}`,
      [r.id],
    )
  }
  const versionRow: Record<string, Value> = {
    id: v.id,
    blob_key: v.blob_key,
    content_type: v.content_type,
    size_bytes: v.size_bytes ?? 0,
    author: v.author,
    author_login: v.author_login ?? null,
    author_avatar: v.author_avatar ?? null,
    author_gh_id: v.author_gh_id ?? null,
    author_id: v.author_id ?? null,
    agent_id: v.agent_id ?? null,
    agent_name: v.agent_name ?? null,
    source: v.source ?? null,
    message: v.message,
    name: v.name ?? null,
    created_at: r.created_at,
  }
  statements.push({
    text: `INSERT INTO version (artifact_id, n, ${Object.keys(versionRow).join(", ")}) SELECT id, current_version + 1, ${Object.keys(
      versionRow,
    )
      .map(() => "?")
      .join(", ")} FROM artifact WHERE id = ? AND short_id = ? AND org_id = ? AND ${claim}`,
    values: [...Object.values(versionRow), artifactId, shortId, r.org_id, r.id],
  })
  const updates: Record<string, Value> = {
    current_content_type: v.content_type,
    updated_at: r.created_at,
    author_name: v.author,
    author_login: v.author_login ?? null,
    author_avatar: v.author_avatar ?? null,
    author_gh_id: v.author_gh_id ?? null,
    author_id: v.author_id ?? null,
    ...("title" in input.target && input.target.title !== undefined
      ? { title: input.target.title, slug: input.target.slug ?? null }
      : {}),
  }
  statements.push({
    text: `UPDATE artifact SET current_version = (SELECT n FROM version WHERE id = ?), ${Object.keys(
      updates,
    )
      .map((key) => `${key} = ?`)
      .join(
        ", ",
      )} WHERE id = ? AND ${claim} AND EXISTS (SELECT 1 FROM version WHERE id = ? AND artifact_id = ?)`,
    values: [v.id, ...Object.values(updates), artifactId, r.id, v.id, artifactId],
  })
  statements.push({
    text: `INSERT INTO workflow_artifact_activity (id, org_id, workflow_run_id, node_id, attempt, artifact_short_id, artifact_version, artifact_title, role, source, created_at) SELECT ?, ?, ?, ?, ?, artifact.short_id, version.n, artifact.title, ?, 'observed', ? FROM artifact JOIN version ON version.artifact_id = artifact.id WHERE artifact.id = ? AND version.id = ? AND ${claim}`,
    values: [
      r.activity_id,
      r.org_id,
      r.workflow_run_id,
      r.node_id,
      r.attempt,
      r.role,
      r.created_at,
      artifactId,
      v.id,
      r.id,
    ],
  })
  // A missing version resolves to NULL and violates NOT NULL. This aborts the
  // entire batch, including the claim, instead of leaving a poisoned retry key.
  statements.push({
    text: "UPDATE workflow_publish_receipt SET artifact_version = (SELECT n FROM version WHERE id = ? AND artifact_id = ?) WHERE id = ?",
    values: [v.id, artifactId, r.id],
  })
  return statements
}

export const checkedWorkflowPublishReceipt = (
  input: WorkflowVersionPublish,
  receipt: WorkflowPublishReceiptRecord | null,
): WorkflowPublishReceiptRecord => {
  if (!receipt || receipt.artifact_version < 1) throw new Error("Workflow publish did not commit")
  if (receipt.request_hash !== input.receipt.request_hash)
    throw new PublishError(
      409,
      "This workflow publish retry key already belongs to a different request",
    )
  return receipt
}
