-- ONE-OFF CUTOVER to the agent model. Previews by default; writes only with -v apply=1.
--
--   psql "$PROD_READONLY_URL" -f scripts/agents-cutover.sql            # preview, read-only
--   psql "$PROD_URL" -v apply=1 -f scripts/agents-cutover.sql          # apply, one transaction
--
-- Additive and idempotent: the old tables keep working, so a runner still on the old lanes is
-- undisturbed while it is switched over, and a second run changes nothing.
--
--   1. Contexts that were ever used (a runner checked in, a session, a Derive runtime, an
--      enabled automation, or a workflow run it served)
--      become their own agent row: instructions (the manifest page), machine (derive when it
--      had a runtime), who may ask, sources, environment, repositories, limits, provider, and
--      last seen. The row stops being a hidden managed agent.
--   2. Enabled scheduled automations become schedules on that agent, and the old automation is
--      disabled in the same transaction, so a window never fires twice.
--   3. Stored model plans become model accounts, the secret copied as is (same encryption),
--      the workspace pool as the workspace's shared account.

\set ON_ERROR_STOP on

\set carried '(SELECT c.* FROM context c WHERE c.runner_seen_at IS NOT NULL OR EXISTS (SELECT 1 FROM context_session s WHERE s.context_id = c.id) OR EXISTS (SELECT 1 FROM context_runtime r WHERE r.context_id = c.id) OR EXISTS (SELECT 1 FROM automation m WHERE m.context_id = c.id AND m.enabled = 1) OR EXISTS (SELECT 1 FROM workflow_run w WHERE w.assigned_agent_id = c.agent_id OR w.executor_id = c.agent_id))'
\set scheduled '(SELECT m.*, coalesce(c.agent_id, m.agent_id) AS target_agent FROM automation m LEFT JOIN context c ON c.id = m.context_id WHERE m.enabled = 1 AND (m.trigger::jsonb)->>''kind'' = ''schedule'' AND NOT EXISTS (SELECT 1 FROM agent_trigger t WHERE t.id = ''trg_'' || m.id))'
\set plans '(SELECT mc.* FROM model_credential mc WHERE NOT EXISTS (SELECT 1 FROM model_account a WHERE a.id = ''acct_'' || mc.id))'

\echo '== 1. Contexts that become agents =='
SELECT w.name AS workspace, c.name, CASE WHEN EXISTS (SELECT 1 FROM context_runtime r WHERE r.context_id = c.id) THEN 'derive' ELSE 'owner' END AS machine, a.instructions_artifact_id IS NOT NULL AS already
FROM :carried c JOIN agent a ON a.id = c.agent_id JOIN workspace w ON w.id = c.org_id ORDER BY 1, 2;

\echo '== 2. Scheduled automations that become schedules =='
SELECT w.name AS workspace, (s.trigger::jsonb)->>'cron' AS cron, (s.trigger::jsonb)->>'tz' AS tz, left(s.instruction, 50) AS instruction
FROM :scheduled s JOIN workspace w ON w.id = s.org_id;

\echo '== 3. Model plans that become accounts =='
SELECT w.name AS workspace, p.provider, p.kind, p.user_id = '__workspace_pool__' AS shared
FROM :plans p JOIN workspace w ON w.id = p.org_id ORDER BY 1;

\if :{?apply}
\echo '== APPLYING =='
BEGIN;
UPDATE agent a SET
  instructions_artifact_id = c.manifest_artifact_id,
  machine = CASE WHEN EXISTS (SELECT 1 FROM context_runtime r WHERE r.context_id = c.id) THEN 'derive' ELSE 'owner' END,
  ask_policy = CASE WHEN c.ask_policy = 'workspace' THEN 'workspace' ELSE 'invited' END,
  connection_ids_json = coalesce(a.connection_ids_json, nullif(c.connection_ids, '[]')),
  environment_json = coalesce(a.environment_json, c.environment_bindings),
  repositories_json = coalesce(a.repositories_json, c.repository_bindings),
  max_run_ms = coalesce(a.max_run_ms, c.max_run_ms),
  max_concurrency = c.max_concurrency,
  provider = coalesce((SELECT m.provider FROM automation m WHERE m.context_id = c.id AND m.enabled = 1 ORDER BY m.created_at DESC LIMIT 1), a.provider),
  seen_at = nullif(greatest(coalesce(a.seen_at, ''), coalesce(c.runner_seen_at, ''), coalesce(a.runs_seen_at, '')), ''),
  managed = 0
FROM :carried c
WHERE a.id = c.agent_id AND a.org_id = c.org_id AND a.instructions_artifact_id IS NULL;

INSERT INTO agent_trigger (id, org_id, agent_id, kind, cron, tz, instruction, enabled)
SELECT 'trg_' || s.id, s.org_id, s.target_agent, 'schedule', (s.trigger::jsonb)->>'cron',
       coalesce((s.trigger::jsonb)->>'tz', 'UTC'), s.instruction, 1
FROM :scheduled s;
UPDATE automation SET enabled = 0 WHERE id IN (SELECT substr(t.id, 5) FROM agent_trigger t WHERE t.id LIKE 'trg_auto_%');

INSERT INTO model_account (id, org_id, user_id, provider, kind, secret_enc, hint, status)
SELECT 'acct_' || p.id, p.org_id,
       CASE WHEN p.user_id = '__workspace_pool__' THEN '__workspace__' ELSE p.user_id END,
       CASE WHEN p.provider = 'codex' THEN 'codex' ELSE 'claude' END,
       p.kind, p.secret, nullif(p.hint, ''), 'ready'
FROM :plans p;
COMMIT;
\echo 'Applied.'
\else
\echo ''
\echo 'Preview only. Re-run against the write URL with -v apply=1 to apply.'
\endif
