import type {
  ContextRecord,
  RuntimeStore,
  WorkflowDraftRecord,
  WorkflowFilesRecord,
  WorkflowTestRecord,
} from "@derive/core"
import { workflowRepositories } from "@derive/core"
import { type SQL, sql } from "drizzle-orm"

type Store = Pick<
  RuntimeStore,
  | "saveWorkflowRepositories"
  | "getWorkflowFiles"
  | "saveWorkflowFiles"
  | "projectWorkflowDraft"
  | "getWorkflowDraft"
  | "saveWorkflowDraft"
  | "createWorkflowTest"
  | "latestWorkflowTest"
  | "getWorkflowTest"
  | "listPendingWorkflowTests"
  | "settleWorkflowTest"
  | "retryRuntimeSetup"
>
export function workflowDraftRepos(execute: (statement: SQL) => Promise<unknown[]>): Store {
  const first = async <T>(statement: SQL) =>
    ((await execute(statement))[0] as T | undefined) ?? null
  return {
    saveWorkflowRepositories: (i) => {
      if (!Number.isSafeInteger(i.revision) || i.revision < 0)
        throw new Error("Invalid repository revision")
      const grants = JSON.stringify(workflowRepositories(i.repositories))
      // Workspace GitHub installations can only be delegated by workspace managers.
      return first<ContextRecord>(sql`UPDATE context SET repository_bindings = ${grants}, repository_revision = repository_revision + 1
        WHERE id = ${i.contextId} AND org_id = ${i.orgId} AND import_source IS NULL AND repository_revision = ${i.revision}
        AND EXISTS (SELECT 1 FROM membership m WHERE m.org_id = context.org_id AND m.user_id = ${i.ownerId} AND m.role = 'owner')
        RETURNING *`)
    },
    getWorkflowFiles: (id, org) =>
      first<WorkflowFilesRecord>(
        sql`SELECT * FROM workflow_files WHERE context_id = ${id} AND org_id = ${org}`,
      ),
    saveWorkflowFiles: (i) => {
      if (
        new Date(i.at).toISOString() !== i.at ||
        (i.revision !== null && (!Number.isSafeInteger(i.revision) || i.revision < 0)) ||
        (i.artifactId === null
          ? i.blobKey !== null || i.version !== null
          : !i.artifactId ||
            !/^[a-f0-9]{64}$/.test(i.blobKey ?? "") ||
            !Number.isSafeInteger(i.version) ||
            (i.version ?? 0) < 1)
      )
        throw new Error("Invalid workflow file selection")
      return first<WorkflowFilesRecord>(sql`
      INSERT INTO workflow_files (context_id, org_id, artifact_id, blob_key, version, granted_by, revision, updated_at)
      SELECT c.id, c.org_id, ${i.artifactId}, ${i.blobKey}, ${i.version}, ${i.ownerId}, 0, ${i.at} FROM context c
      JOIN membership m ON m.org_id = c.org_id AND m.user_id = ${i.ownerId}
      WHERE c.id = ${i.contextId} AND c.org_id = ${i.orgId} AND c.import_source IS NULL
        AND m.role IN ('owner', 'editor')
        AND (c.created_by = ${i.ownerId} OR m.role = 'owner')
        AND (cast(${i.revision} AS integer) IS NULL OR EXISTS (SELECT 1 FROM workflow_files f WHERE f.context_id = c.id))
      ON CONFLICT (context_id) DO UPDATE SET artifact_id = excluded.artifact_id, blob_key = excluded.blob_key, version = excluded.version,
        granted_by = excluded.granted_by, revision = workflow_files.revision + 1, updated_at = excluded.updated_at
      WHERE workflow_files.org_id = excluded.org_id AND workflow_files.revision = ${i.revision ?? -1}
      RETURNING *`)
    },
    projectWorkflowDraft: async (id, org, owner, at) => {
      // The existing Automation becomes the sole instruction/schedule owner once a runtime exists.
      // Freeze the source before projection. An edit's CAS checks this same row, so even
      // concurrent Postgres snapshots cannot edit instructions after handover begins.
      await execute(sql`UPDATE workflow_draft SET sealed_at = coalesce(sealed_at, ${at})
        WHERE context_id = ${id} AND org_id = ${org}
        AND EXISTS (SELECT 1 FROM context_runtime rt WHERE rt.context_id = workflow_draft.context_id AND rt.disabled_at IS NULL) RETURNING context_id`)
      await execute(sql`INSERT INTO automation (id, org_id, agent_id, context_id, runtime_id, created_by, trigger, instruction, provider, enabled, revision, created_at, updated_at)
        SELECT ${`auto_${id}`}, d.org_id, rt.agent_id, d.context_id, rt.id, ${owner}, '{"kind":"manual"}', d.instruction, d.provider, 0, 0, ${at}, ${at}
        FROM workflow_draft d JOIN context_runtime rt ON rt.context_id = d.context_id AND rt.org_id = d.org_id
        WHERE d.context_id = ${id} AND d.org_id = ${org} AND rt.disabled_at IS NULL AND d.instruction <> ''
        ON CONFLICT DO NOTHING RETURNING id`)
      await execute(sql`DELETE FROM workflow_draft WHERE context_id = ${id} AND org_id = ${org}
        AND EXISTS (SELECT 1 FROM automation a WHERE a.context_id = workflow_draft.context_id AND a.org_id = workflow_draft.org_id AND a.runtime_id IS NOT NULL) RETURNING context_id`)
    },
    getWorkflowDraft: (id, org) =>
      first<WorkflowDraftRecord>(
        sql`SELECT * FROM workflow_draft WHERE context_id = ${id} AND org_id = ${org}`,
      ),
    saveWorkflowDraft: (i) =>
      first<WorkflowDraftRecord>(sql`
      INSERT INTO workflow_draft (context_id, org_id, instruction, provider, revision, updated_at)
      SELECT c.id, c.org_id, ${i.instruction}, ${i.provider}, 0, ${i.at} FROM context c
      JOIN membership m ON m.org_id = c.org_id AND m.user_id = ${i.ownerId}
      WHERE c.id = ${i.contextId} AND c.org_id = ${i.orgId} AND c.import_source IS NULL
        AND (c.created_by = ${i.ownerId} OR m.role = 'owner')
        AND NOT EXISTS (SELECT 1 FROM automation a WHERE a.context_id = c.id AND a.org_id = c.org_id AND a.runtime_id IS NOT NULL)
        AND (cast(${i.revision} AS integer) IS NULL OR EXISTS (SELECT 1 FROM workflow_draft d WHERE d.context_id = c.id))
      ON CONFLICT (context_id) DO UPDATE SET instruction = excluded.instruction, provider = excluded.provider,
        revision = workflow_draft.revision + 1, updated_at = excluded.updated_at
      WHERE workflow_draft.sealed_at IS NULL AND workflow_draft.org_id = excluded.org_id AND workflow_draft.revision = ${i.revision ?? -1}
      RETURNING *`),
    createWorkflowTest: async (i, at) => {
      await execute(sql`INSERT INTO workflow_test (id, context_id, org_id, initiated_by, config_revision, input_snapshot, status, created_at)
        SELECT ${i.id}, c.id, c.org_id, ${i.initiated_by}, ${i.config_revision}, ${i.input_snapshot}, 'pending', ${at}
        FROM context c WHERE c.id = ${i.context_id} AND c.org_id = ${i.org_id}
        ON CONFLICT DO NOTHING RETURNING id`)
      return first<WorkflowTestRecord>(sql`SELECT * FROM workflow_test WHERE id = ${i.id} AND org_id = ${i.org_id}
        AND context_id = ${i.context_id} AND initiated_by = ${i.initiated_by} AND config_revision = ${i.config_revision}`)
    },
    latestWorkflowTest: (id, org, viewer) =>
      first<WorkflowTestRecord>(
        sql`SELECT * FROM workflow_test WHERE context_id = ${id} AND org_id = ${org} AND initiated_by = ${viewer} ORDER BY created_at DESC, id DESC LIMIT 1`,
      ),
    getWorkflowTest: (id, org) =>
      first<WorkflowTestRecord>(
        sql`SELECT * FROM workflow_test WHERE id = ${id} AND org_id = ${org}`,
      ),
    listPendingWorkflowTests: async () =>
      (await execute(
        sql`SELECT * FROM workflow_test WHERE status = 'pending' ORDER BY created_at, id LIMIT 100`,
      )) as WorkflowTestRecord[],
    settleWorkflowTest: async (id, org, status) => {
      await execute(
        sql`UPDATE workflow_test SET status = ${status} WHERE id = ${id} AND org_id = ${org} AND status = 'pending' RETURNING id`,
      )
    },
    // Terminal failure means the existing setup saga has confirmed cleanup. A new attempt
    // gets a new remote idempotency key; active or ambiguously-created machines cannot be retried.
    retryRuntimeSetup: async (id, org, revision) =>
      (
        await execute(sql`DELETE FROM runtime_setup
      WHERE context_id = ${id} AND org_id = ${org} AND phase = 'failed' AND revision = ${revision}
      AND NOT EXISTS (SELECT 1 FROM context_runtime rt WHERE rt.context_id = runtime_setup.context_id) RETURNING id`)
      ).length > 0,
  }
}
