# Open-artifact source preview

Derive consumes the first extracted artifact source rules from a packed preview.
The source lives in `derive-to/open-artifact`. It does not live in this folder.
The preview contains the verified 0.5.2 protocol distribution and the shared
source entry. The companion JSON records the source hashes and package hash.

This keeps the first consumer reproducible before a registry release exists.
It does not require npm publishing credentials or a cross-checkout source link.
Replace the file dependency with the exact released version after the core PR
ships. Remove this folder's preview files in that same change.

The preview adds no database schema, roles, or artifact URL changes.
