-- PRE-DEPLOY CHECK for the hosted-runs branch. READ-ONLY: every statement is a SELECT.
--
-- Why this exists. Deploying this branch does NOT turn hosted execution on (the Cloudflare
-- blocks ship commented, DERIVE_HOSTED_RUNS defaults off). But two behaviours DO go live the
-- moment it ships, because both hang off /v1/agent/runs/claim, which existing runners already
-- poll every minute:
--
--   1. THE SCHEDULE TICK. A polling agent now materializes its automations' due cron runs.
--      Any `schedule` automation that has been sitting dormant — because nothing ever ticked —
--      starts firing on the next poll, spending the initiator's model plan and writing through
--      the gate.
--   2. THE RECLAIM SWEEP. Runs stuck `running` past the lease return to `queued` and are
--      re-executed (up to the attempt cap, then finished `lost`).
--
-- Neither is reckless — writes still pass the autonomy gate, and budget/caps now guard dispatch
-- — but neither is a no-op on existing data. Run this first so the blast radius is a number you
-- have seen rather than one you find out about.
--
--   psql "$PROD_READONLY_URL" -f scripts/pre-deploy-hosted-runs.sql

\echo '== 1. Dormant schedule automations: these START FIRING after deploy =='
-- Enabled, cron-triggered, and with no run in the last 24h — i.e. nothing has been executing
-- them. Each one becomes a live job on the next runner poll.
SELECT a.id,
       a.org_id,
       substring(a.instruction for 60) AS instruction,
       a.trigger::json ->> 'cron'      AS cron,
       (SELECT max(r.created_at) FROM run r WHERE r.automation_id = a.id) AS last_run
FROM automation a
WHERE a.enabled = 1
  AND a.trigger::json ->> 'kind' = 'schedule'
  AND NOT EXISTS (
        SELECT 1 FROM run r
        WHERE r.automation_id = a.id
          AND r.created_at > (now() - interval '24 hours')::text
      )
ORDER BY a.org_id, a.id;

\echo ''
\echo '== 2. Stuck running runs: these get REQUEUED and re-executed after deploy =='
-- `running` for longer than the 25-minute lease. Each is re-dispatched (attempt count in meta),
-- and finished `lost` once past the cap. A large number here means a past executor died en
-- masse; consider settling them by hand before deploying.
SELECT r.id,
       r.org_id,
       r.automation_id,
       r.reason,
       r.started_at,
       (CASE WHEN r.meta IS NULL THEN NULL ELSE r.meta::json ->> 'attempts' END) AS prior_attempts
FROM run r
WHERE r.status = 'running'
  AND (r.started_at IS NULL OR r.started_at < (now() - interval '25 minutes')::text)
ORDER BY r.started_at NULLS FIRST;

\echo ''
\echo '== 3. Blast-radius summary =='
SELECT
  (SELECT count(*) FROM automation a
    WHERE a.enabled = 1 AND a.trigger::json ->> 'kind' = 'schedule')          AS enabled_schedules,
  (SELECT count(*) FROM run WHERE status = 'running')                          AS running_runs,
  (SELECT count(*) FROM run WHERE status = 'queued')                           AS queued_runs,
  -- Workspaces that have turned hosted agents OFF are unaffected either way: dispatch skips
  -- them entirely, and the schedule tick only materializes work a runner then has to claim.
  -- (org_settings stores one JSON blob, not columns.)
  (SELECT count(*) FROM org_settings
    WHERE settings::json ->> 'hostedAgentsEnabled' = 'false')                  AS workspaces_opted_out;

\echo ''
\echo 'If (1) and (2) are both empty, deploying changes no existing behaviour.'
\echo 'If (1) is non-empty, those automations begin running: confirm that is wanted,'
\echo 'or disable them (enabled = 0) before deploy and re-enable deliberately.'
