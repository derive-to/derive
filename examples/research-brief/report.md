# SQLite or PostgreSQL for a small internal service

> Official Derive example. The service and workload below are illustrative. The linked
> documentation is real and should be checked again when the deployment changes.

## Question

Which database should a small internal operations service use for its first release?

The current plan is one application instance, fewer than 20 staff users, low write traffic,
and a database stored on the same machine as the service. The team can stop the service for a
restore and does not need automatic failover.

## Recommendation

Start with SQLite while those conditions remain true. It keeps the deployment small and fits
a workload with one application host and few simultaneous writes.

Choose PostgreSQL before launch if the service needs more than one application instance,
direct database access over a network, many concurrent writers, or database-level high
availability. Those are architectural boundaries, not problems to postpone with tuning.

## Evidence

| What matters | What the documentation says | Effect on this decision |
| --- | --- | --- |
| Deployment | SQLite describes local, application-owned storage as a strong fit. PostgreSQL uses a client-server model. | SQLite is simpler for the planned single-host service. |
| Concurrent writes | SQLite serializes writes. WAL mode lets readers continue while a writer is active, but there is still only one writer at a time. | The expected write rate is low enough, but write contention should be tested with realistic imports. |
| Network storage | SQLite says WAL does not work over a network filesystem because processes must share memory. | Keep the database file on the application host. Do not place it on shared network storage. |
| Multiple servers | PostgreSQL accepts connections from separate clients and documents several high-availability configurations. | Move to PostgreSQL if the service needs horizontal application scaling or database failover. |

## Assumptions to verify

- Imports do not create sustained concurrent writes.
- One application instance is acceptable for the first release.
- The database file stays on local storage.
- A documented backup and restore test meets the team's recovery needs.

## What would change the recommendation

Move to PostgreSQL if any of these become requirements:

- two or more application instances writing to the same database;
- database access from other machines or tools;
- automatic failover or read replicas;
- write contention that is visible in a production-like load test.

## Sources

- [SQLite: Appropriate Uses for SQLite](https://www.sqlite.org/whentouse.html)
- [SQLite: Write-Ahead Logging](https://www.sqlite.org/wal.html)
- [PostgreSQL: Architectural Fundamentals](https://www.postgresql.org/docs/current/tutorial-arch.html)
- [PostgreSQL: High Availability, Load Balancing, and Replication](https://www.postgresql.org/docs/current/high-availability.html)
