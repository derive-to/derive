# Moving scheduled jobs off the app server

> Official Derive example. The service, dates, and numbers are illustrative. The behaviour
> described for cron, systemd timers, and queue workers is real and worth checking against
> your own versions.

**Status:** Decided, build in progress
**Owner:** Platform
**Decision date:** 12 March
**Last change:** Split the rollout into two phases after the load test.

## The problem

Twenty-two scheduled jobs run from cron on a single application server. Three of them matter
enough that a silent failure is a customer-visible incident: the nightly invoice export, the
subscription renewal sweep, and the search index rebuild.

Three things are wrong with the current setup.

1. A job that fails leaves no record anywhere a person will look. Cron mails the output to a
   local mailbox nobody reads.
2. The server is a single point of failure. When it was replaced in January, four jobs did
   not run for two days and nobody noticed until an invoice was missing.
3. Two jobs have started to overlap. The index rebuild now takes longer than its own
   interval, so a second copy starts while the first is still writing.

## Decision

Move the three critical jobs to a queue with durable state, and leave the remaining nineteen
on timers.

This is deliberately not a single migration. The nineteen low-stakes jobs (cache warming,
log rotation, report pre-generation) do not justify queue infrastructure. Moving them would
triple the work for no reduction in risk.

## What we are building

| Piece | Choice | Why this one |
| --- | --- | --- |
| Scheduler | systemd timers | Already on the host, logs to the journal, and reports failure as a unit state a monitor can read. Cron reports nothing. |
| Queue | Postgres-backed job table | The database is already there and already backed up. A dedicated broker adds an operational component for a workload of roughly 400 jobs a day. |
| Overlap protection | Advisory lock per job name | The index rebuild cannot start twice. The lock lives with the data, so it survives a worker restart. |
| Visibility | A row per run, with start, end, and outcome | The question we could not answer ("did it run?") becomes a query. |

## Why not a dedicated queue service

We looked at running a broker. It is the better answer at a larger volume, and it is the
wrong answer here.

- The workload is about 400 jobs a day with no fan-out. A broker is built for far more.
- It adds a component that has to be monitored, upgraded, and restored on its own schedule.
- The failure we are actually fixing is invisibility, not throughput. A job table with a
  status column fixes invisibility today.

If daily volume passes roughly 50,000 jobs, or jobs need to fan out across several workers,
this decision should be revisited. That is the trigger, not a date.

## Rollout

**Phase one.** Move the invoice export only. It runs once a day, its output is checked by a
person the next morning, and a missed run is recoverable by hand. It is the safest way to
find out what we got wrong.

**Phase two.** Move the renewal sweep and the index rebuild once the export has completed
fourteen consecutive runs without manual help.

Phase two was originally the same change as phase one. The load test showed the index
rebuild holding a lock for around nine minutes under production-like data, which would have
blocked the renewal sweep behind it. Splitting the phases lets us fix the lock granularity
before both jobs depend on it.

## Open questions

| Question | Owner | Needed by |
| --- | --- | --- |
| Should a failed job retry automatically, or wait for a person? | Platform | Before phase one ships |
| How long do we keep run history? Ninety days was assumed, never agreed. | Platform with Finance | Before phase two |
| Does the index rebuild need to hold one lock, or one per shard? | Search | Before phase two |

## What would change this plan

- Daily job volume passing roughly 50,000, or jobs needing to fan out: move to a broker.
- The database becoming the bottleneck under normal load: the job table is the first thing to
  move off it.
- A second application server: the advisory lock still holds, but the timers need to run on
  exactly one host, which is a scheduling problem we have not solved here.

## Verified so far

- A load test with production-shaped data reproduced the nine-minute index lock.
- Killing a worker mid-job leaves the row in `running` and the advisory lock released, so the
  next run picks it up. This is the behaviour we want, and it was not obvious beforehand.
- systemd reports a non-zero exit as a failed unit state, which the existing monitor already
  reads. No new monitoring surface is needed for phase one.
