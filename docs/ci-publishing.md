# Publishing from CI

Use Derive's GitHub Actions composite action to turn any CI output into a living artifact — a
versioned, commentable page that reviewers reach without downloading anything.

## The two patterns

### PR preview (build-and-review)

Every pull request builds the artifact and drops a review link in the PR. Reviewers comment on
the rendered page, not on the diff.

```yaml
# .github/workflows/preview.yml
name: Preview
on:
  pull_request:

permissions:
  contents: read
  pull-requests: write   # needed to post the review comment

jobs:
  preview:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Build (if needed)
        run: npm ci && npm run build   # skip if publishing a raw file
      - uses: derive-to/derive/.github/actions/derive-publish@main
        with:
          server: ${{ vars.DERIVE_SERVER }}
          token: ${{ secrets.DERIVE_TOKEN }}
          path: ./dist           # built directory or a single file
          name: ${{ github.sha }}
```

The action posts one comment per artifact and updates it on every push, so the PR always shows
the latest version.

### Scheduled report (living artifact)

A recurring job updates the same artifact in place. Every run creates a new version, and readers
browse history or subscribe to the feed. There is nothing to poll — the artifact is always
current.

```yaml
# .github/workflows/weekly-report.yml
name: Weekly report
on:
  schedule:
    - cron: "0 12 * * 5"   # Fridays at noon UTC
  workflow_dispatch:        # run manually too

permissions:
  contents: read

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Generate report
        run: node scripts/build-report.js > report.md
        env:
          # any secrets your generator needs
          API_KEY: ${{ secrets.API_KEY }}

      - uses: derive-to/derive/.github/actions/derive-publish@main
        with:
          server: ${{ vars.DERIVE_SERVER }}
          token: ${{ secrets.DERIVE_TOKEN }}
          id: ${{ vars.REPORT_ARTIFACT_ID }}  # short_id of the artifact to update
          path: ./report.md
          name: ${{ github.run_id }}
          comment-pr: "false"   # not a PR workflow
```

Store the artifact's `short_id` (from the initial publish) in a repo variable
(`REPORT_ARTIFACT_ID`). Every run adds a version to that artifact without creating a new one.

## Setup

1. **Mint a token.** Open Settings → Agents → New agent. Give it publish-only scope and save the
   token. For a report that only updates one artifact, scope it to that artifact's short_id.

2. **Store the token** as a secret: `DERIVE_TOKEN` in the repository or organisation secrets.

3. **Set the server URL** as a variable (`DERIVE_SERVER`, e.g. `https://derive.to`).

4. **First publish.** Run the workflow once (or publish via the CLI) and note the `short_id` in
   the output. For a living artifact, store it as `REPORT_ARTIFACT_ID`.

## Using the CLI directly

If you'd rather call the CLI than use the action, install `@derive-to/cli` and run:

```bash
npx @derive-to/cli publish ./report.md \
  --id "$REPORT_ARTIFACT_ID" \
  --name "$GITHUB_RUN_ID" \
  --json
```

`DERIVE_SERVER` and `DERIVE_TOKEN` are picked up from the environment automatically.

## Reading the published URL

The action exposes three outputs:

```yaml
- uses: derive-to/derive/.github/actions/derive-publish@main
  id: derive
  with: { ... }
- run: echo "Published ${{ steps.derive.outputs.url }}"
```

| Output     | Value                                  |
| ---------- | -------------------------------------- |
| `url`      | Canonical artifact URL.                |
| `short_id` | Short id (stable across versions).     |
| `embed`    | Ready-to-paste `<iframe>` snippet.     |

## Notes

- **Visibility.** A new artifact defaults to private. Pass `visibility: link` to make it
  link-accessible without sign-in, or `visibility: public` to list it publicly.
- **Version names.** Use `${{ github.sha }}` for PR previews, `${{ github.run_id }}` or a
  human-readable date for scheduled reports. Names appear in the version history drawer.
- **HTML output.** Derive renders HTML natively. If your generator produces HTML, publish the
  file directly — the styled page renders as authored, no conversion.
