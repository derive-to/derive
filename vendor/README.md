# Open-artifact packed preview

Derive consumes immutable protocol, runtime, and server packages from
`derive-to/open-artifact`. The source does not live in this folder.
The companion JSON records the exact source commit, source hashes, and package hashes.

The packed candidate makes the consumer reproducible before a registry release.
It needs no publishing credentials or link to another checkout.
After the core release, replace these file dependencies with its exact released version.
Remove the preview packages in the same change.

The adapter preserves native source, storage, access, attribution, and artifact URLs.
