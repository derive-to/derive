# Bundle example

Most examples are one file. This one is four pages and a stylesheet published as a single
artifact, which is the right shape for anything with sections a reader navigates between: a
handbook, a spec with appendices, a small site, a report with its own supporting pages.

The whole bundle is one URL, one version history, and one set of permissions. Sharing it
shares all of it, and a reader does not have to reassemble four links.

## Publish it

The CLI zips the directory for you:

```bash
cd examples/handbook
derive publish
```

The root `index.html` becomes the entry page. Other pages reference each other and the
stylesheet by relative path, exactly as they do on disk, so what you check locally is what
readers get.

## The rule that catches people out

**Republishing a bundle replaces it.** Publishing only the page you edited deletes the other
three. Either publish the whole directory again, or merge the changed files into the existing
bundle.

## What this example is careful about

**It is genuinely navigable.** Every page carries the same navigation and marks the page you
are on with `aria-current`, so the bundle reads as one document rather than four files that
happen to share a URL.

**It stays one artifact.** Splitting these four pages into four artifacts would mean four
version histories and four sets of permissions for something that is only ever read and
revised together.

## Suggested prompt

> Read the handbook end to end and check it against what we actually do now. Fix anything
> stale, keep every page's navigation consistent, and republish the whole bundle rather than
> a single page. Say in the version message what changed and why.

## Where a bundle is the wrong choice

Facts blocks are single-file only, so a page whose numbers you want to read back as a series
should be its own artifact. The [living status example](../living-status/) shows that shape.
