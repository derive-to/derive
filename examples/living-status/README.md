# Living status example

A status document is the clearest case for a durable URL. The alternative is a new message
every week, where the current picture has to be reassembled from the last four updates and
nobody is sure which one is still true.

This one is a designed page rather than prose, because a status is read at a glance before it
is read closely. The counts are visible immediately, the reversal is visible next, and the
detail is there for whoever needs it.

[Open the official live example](https://derive.to/artifacts/customer-import-rollout-current-status-f49k4yvg).

## Publish it, then keep publishing

```bash
derive publish --name "Week 4"

# next week
derive publish --name "Week 5" --message "Recovery test moved back to open: the earlier run
used a file with no failures, so it never exercised the restart path."
```

Named versions give the timeline anchors a reader can jump between.

## The numbers read back as a series

The page carries an inert `derive-facts` block, so each version's figures are extracted and
kept. A page republished weekly stops being thirty pages you have to re-read.

```
read(short_id, data:"rollout")                 # this version
read(short_id, data:"rollout", versions:"all") # every version, oldest first
```

The same data is a URL, so a shell can chart it:

```bash
curl -s https://derive.to/raw/<short_id>/data/rollout.jsonl | jq -s 'map(.blocked)'
```

The block lives inside the page, so it cannot drift from the numbers a reader sees. Update
both or neither.

## What this example is careful about

**It states what is not true yet.** The closing list rules out concurrent imports, large
files, and automatic retry. Without it, the workstream table reads as complete coverage.

**It records a reversal.** The recovery test moved from done back to open, and the page says
why. A status that only ever advances is being performed, not maintained.

**Every workstream has an owner and a next action.** A row with neither is a wish.

## Suggested recurring prompt

> Update the status from this week's evidence, including moving something backwards if what
> we thought was done was not. Keep the facts block in step with the visible numbers. Every
> open risk needs an owner and a next action. Publish a named version whose message says what
> changed and why.
