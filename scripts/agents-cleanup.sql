-- ONE-OFF CLEANUP before the agents rebuild. Previews by default; writes only with -v apply=1.
--
--   psql "$PROD_READONLY_URL" -f scripts/agents-cleanup.sql            # preview, read-only
--   psql "$PROD_URL" -v apply=1 -f scripts/agents-cleanup.sql          # apply, one transaction
--
-- Three kinds of dead row, none of which anything will ever act on:
--
--   1. Managed agents nothing references. Every Context and automation used to mint a hidden
--      agent row; deleted Contexts, test automations, and failed creates left rows behind that
--      hold a token hash nobody has. Kept if ANY table still points at the id, including
--      attribution (versions, comments, mentions, review rounds), so no history loses its author.
--   2. Workflow runs stuck queued/dispatched/running for more than a week. Nothing reconciles
--      them, so they sit open forever. Settled as cancelled.
--   3. Automation runs queued for more than a week. They were materialized by a lane that no
--      longer exists (a stale staging Worker with a production cron) and nothing will dispatch
--      them. Settled as failed with the reason recorded in meta.

\set ON_ERROR_STOP on

\echo '== 1. Managed agents with no references =='
\set orphan_agents '(SELECT a.id, a.org_id, a.name, a.created_at FROM agent a WHERE a.managed = 1   AND NOT EXISTS (SELECT 1 FROM context c WHERE c.agent_id = a.id)   AND NOT EXISTS (SELECT 1 FROM automation m WHERE m.agent_id = a.id)   AND NOT EXISTS (SELECT 1 FROM context_runtime r WHERE r.agent_id = a.id)   AND NOT EXISTS (SELECT 1 FROM runtime_setup s WHERE s.agent_id = a.id)   AND NOT EXISTS (SELECT 1 FROM run r WHERE r.agent_id = a.id)   AND NOT EXISTS (SELECT 1 FROM workflow_run w WHERE w.assigned_agent_id = a.id OR w.executor_id = a.id)   AND NOT EXISTS (SELECT 1 FROM version v WHERE v.agent_id = a.id)   AND NOT EXISTS (SELECT 1 FROM comment c WHERE c.author_id = a.id)   AND NOT EXISTS (SELECT 1 FROM agent_mention m WHERE m.agent_id = a.id)   AND NOT EXISTS (SELECT 1 FROM review_round rr WHERE rr.requested_by = a.id))'
SELECT count(*) AS orphan_agents FROM :orphan_agents o;
SELECT o.name, w.name AS workspace, o.created_at::timestamptz::date AS made
FROM :orphan_agents o JOIN workspace w ON w.id = o.org_id
ORDER BY o.created_at DESC LIMIT 20;

\echo '== 2. Workflow runs open for more than 7 days =='
\set stuck_workflow_runs '(SELECT id, org_id, status, requested_execution, created_at FROM workflow_run WHERE status IN (''queued'', ''dispatched'', ''running'', ''waiting'') AND created_at::timestamptz < now() - interval ''7 days'')'
SELECT status, requested_execution, count(*) FROM :stuck_workflow_runs s GROUP BY 1, 2;

\echo '== 3. Automation runs queued for more than 7 days =='
\set stale_queued_runs '(SELECT id, org_id, automation_id, reason, created_at FROM run WHERE status = ''queued'' AND created_at::timestamptz < now() - interval ''7 days'')'
SELECT w.name AS workspace, count(*), min(r.created_at::timestamptz::date), max(r.created_at::timestamptz::date)
FROM :stale_queued_runs r JOIN workspace w ON w.id = r.org_id GROUP BY 1;

\if :{?apply}
\echo '== APPLYING =='
BEGIN;
DELETE FROM agent WHERE id IN (SELECT id FROM :orphan_agents o);
UPDATE workflow_run
   SET status = 'cancelled', finished_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
       updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
       state_revision = state_revision + 1
 WHERE id IN (SELECT id FROM :stuck_workflow_runs s);
UPDATE run
   SET status = 'failed', finished_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
       meta = (coalesce(nullif(meta, '')::jsonb, '{}'::jsonb)
               || '{"outcome":"failed","why":"never dispatched; cleared before the agents rebuild","retryable":false}'::jsonb)::text
 WHERE id IN (SELECT id FROM :stale_queued_runs r);
COMMIT;
\echo 'Applied.'
\else
\echo ''
\echo 'Preview only. Re-run against the write URL with -v apply=1 to apply.'
\endif
