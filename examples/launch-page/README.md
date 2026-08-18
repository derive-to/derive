# Launch page example

A launch page is a design decision, not a paragraph of text. Flattening it into a summary
throws away the hierarchy, the emphasis, and the sequence a reader moves through, which is
most of what there is to review.

This page is kept as the artifact itself: styled, responsive, and readable in light or dark.
A reviewer can challenge the promise, a specific metric, or the order of the sections,
because all of those are actually present.

## Publish it

```bash
derive publish
```

## What this example is careful about

**Sample numbers are labelled as sample numbers.** The metric cards say so, and the footer
says why. A launch page that cannot show real figures should admit it rather than let three
large numerals imply a customer base.

**The specification names what is not included.** The last row of the spec table rules
things out. A page that only lists strengths is not reviewable, because there is nothing in
it a reader can check and disagree with.

## Suggested prompt

> Read the page as a buyer who has not heard of this product. Is the promise specific enough
> to be wrong? Is every number clearly sample data? Is the primary action obvious before the
> first scroll? Comment on the exact sentence or control that needs work rather than
> summarising, then revise the page and publish the new version.

## Revising it

Design feedback arrives as "the hero is doing too much", not as a diff. Keep the version
message about the intent so the history stays readable.

```bash
derive publish --message "Cut the hero to one claim. Three competing statements meant a
reader finished the fold without knowing what the product settles."
```
