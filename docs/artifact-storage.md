# Artifact storage

Derive keeps its storage schema and access rules. The open-artifact integration uses
the `MetaStore` port to store artifact metadata and versions.

## Publication

`createPublishedArtifact` commits the artifact and its first version together.
If the version insert fails, the artifact insert rolls back. Blob writes happen
before this transaction. An unused blob cannot become a published artifact.

`createArtifact` remains available for drafts and host workflows that need an
artifact before publication.

## Version writes

Each store implements version writes through its native transaction mechanism.
SQLite uses synchronous transactions. PostgreSQL uses transactions and existing
conditional SQL statements. D1 uses transactional batches.

`addVersion` assigns the next number and updates the artifact head together.
`addVersionIfCurrent` does the same only if the expected head still exists.
Competing conditional writes have one winner. A losing write returns `null`.

`replaceCurrentVersion` checks both the head number and the stored blob key.
It preserves the version ID and number. It updates the content and attribution,
clears preview fields, deletes extracted facts, and updates the artifact head.
These changes commit together. A stale replacement returns `null` without changes.

D1 checks `changes()` immediately after the conditional version update. It updates
the head before it deletes facts. This order also supports versions without facts.

The portable repositories do not implement these writes. This prevents callers
from using a sequence of separate writes where a transaction is required.
