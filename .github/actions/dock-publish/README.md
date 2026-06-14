# dock-publish action

Publish an artifact to a [Dock](../../../README.md) server from CI, then drop the
review URL on the pull request as a comment. CI builds the page, Dock hosts it at a
versioned URL, and reviewers comment on the rendered result. The comment is updated
in place on each push, so a PR always points at the latest version.

## Usage

```yaml
name: Publish to Dock
on:
  pull_request:
    paths: ["docs/**", "report.md"]

permissions:
  contents: read
  pull-requests: write # needed to comment the review URL on the PR

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      # If you build a site first, do it here and point `path` at the output dir.
      - uses: Niftory/dock.build/.github/actions/dock-publish@main
        id: dock
        with:
          server: ${{ vars.DOCK_SERVER }}
          token: ${{ secrets.DOCK_TOKEN }}
          path: ./report.md # or a built directory, e.g. ./dist
          name: ${{ github.sha }} # checkpoint each version with the commit
      - run: echo "Published ${{ steps.dock.outputs.url }}"
```

In your own repo with a `dock.json` checked in, `path` and `id` default to its
`entry`/`id`, so `with: { server, token }` is enough.

## Inputs

| Input         | Required | Default     | Description                                                            |
| ------------- | -------- | ----------- | ---------------------------------------------------------------------- |
| `server`      | yes      |             | Dock server URL, e.g. `https://dock.example.com`.                      |
| `token`       | yes      |             | Dock API token (scoped agent token or instance `DOCK_TOKEN`). Secret.  |
| `path`        | no       | dock.json   | File or directory to publish.                                          |
| `id`          | no       | dock.json   | Existing artifact short id to add a version to.                        |
| `title`       | no       |             | Title for a new artifact.                                              |
| `visibility`  | no       |             | `public` \| `link` \| `org` \| `password`.                            |
| `name`        | no       |             | Version checkpoint name (e.g. a sha or release tag).                   |
| `comment-pr`  | no       | `true`      | Comment the URL on the PR (when the run is a `pull_request`).          |
| `cli-version` | no       | `latest`    | `@dock/cli` version/dist-tag run via `npx`.                            |

## Outputs

| Output     | Description                                  |
| ---------- | -------------------------------------------- |
| `url`      | The artifact's canonical URL.                |
| `short_id` | The artifact short id.                       |
| `embed`    | A ready-to-paste `<iframe>` embed snippet.   |

## Notes

- Mint a scoped token in workspace settings (Settings → Agents) and store it as the
  `DOCK_TOKEN` secret. A token that can only publish one artifact is the safe choice
  for CI.
- `pull-requests: write` permission is required for the PR comment. Omit it (or set
  `comment-pr: false`) to publish without commenting.
- The action calls `dock publish --json` under the hood, so it works against any
  Dock instance reachable from the runner.
