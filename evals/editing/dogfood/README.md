# Editing preview dogfood

These synthetic artifacts make editing bugs reproducible without private production data or
a local database seed. Publish each fixture once, keep its short id stable, and open that same
id on production or a PR preview. PR previews share Derive's database bindings, so only the host
changes:

They complement the 109-case always-on regression pass and 112-case full corpus. Luna Round 13
completed with no new reproducible P0–P2 editing bug across Markdown, HTML, deck/video, API, and
browser lanes.

Workspace: **Zero Prime** (`ws_664l6ag4wao3ka0a`)

Shared bundle: `https://derive.to/artifacts/nj1s3mcj`

Reliability loop: `https://derive.to/artifacts/kp7wl0cm`

```text
https://derive.to/artifacts/<short-id>
https://derive-pr-<number>.derive-to.workers.dev/artifacts/<short-id>
```

Use a fresh version for each recipe, or choose **Discard** before starting the next one. The
visible case cards name the gesture and expected result without repeating the exact target text,
so contextual quote selection remains realistic. Important deterministic failures belong in
`../corpus.json`; these artifacts are the human/browser repro surface, not the only oracle.

`published.json` records the stable shared fixture ids after publication. Never replace these
with `.dogfood-data`: that directory is intentionally local and preview deployments cannot see it.
