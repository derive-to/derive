---
name: finding
summary: search a workspace and answer from what you read; explains literal search, find modes, and citations (find, read)
order: 2
---
# Finding things, and answering from them

How to go from a question to an answer that is actually grounded: `find` locates, `read` opens,
and every claim you make names the document it came from.

## THE SEARCH IS LITERAL

`find(query:"…")` matches the CHARACTERS you send against the stored text. It is not semantic,
it does not stem, and it does not understand a question. This is the single most common way a
search comes back empty when the answer was sitting right there:

- **Good:** `find(query:"onboarding")` uses one distinctive word.
- **Bad:** `find(query:"what do we have about onboarding")`. No document may contain that sentence, so
  this returns nothing and tells you nothing about what the workspace holds.

So: **take the person's question, pick the one word most likely to appear in the document, and
search that.** If it comes back empty, that is a signal to try a NEIGHBOURING word, not to
conclude the workspace is empty:

- Try the stem or the other form: `pricing` → `price`, `invoices` → `invoice`.
- Try the noun someone would actually have typed in a title: `how do we bill people` →
  `billing`, then `seats`, then `invoice`.
- Try browsing instead (below). A small workspace is often faster to scan than to search by guesswork.

Two or three honest attempts, THEN say you found nothing. Saying "there is nothing about X" after
one bad query is a false statement about someone's own workspace.

## Which find mode

`find` is one tool with three modes, chosen by what you pass:

| You pass | You get |
| --- | --- |
| `query` alone | Workspace content search: which artifacts contain this text |
| `short_id` + `query` | Grep INSIDE that one artifact: matching lines with line numbers |
| neither | Browse the library: every artifact you can see, with titles and tags |

Also: `tag` narrows browse to a label; `data:"<fact>"` reads one structured fact across every
artifact that carries it (`data:"*"` lists the vocabulary). `in:"text"` searches the visible
text rather than the source, which is what you want when the source is HTML and the person is
asking about what a reader sees.

**Browse is underrated.** For "what do we have on X" in a small workspace, browsing and reading
titles is often better than guessing search words. It cannot return a false empty result.

## Then read

A search hit tells you a document MENTIONS a word. It does not tell you what the document says.
If the question is about what a document decided, changed, or requires, open it:

- `read(short_id)` for a small document; a large one returns its heading OUTLINE instead, and
  you then call again with a `section` slug for just that part.
- `find(short_id, query)` first when you want the LINE the word is on, then `read(short_id,
  lines:"40-80")` for the surrounding context. Cheaper than reading a whole page.
- `format:"text"` is what a reader sees; `format:"html"` is the exact source (what you would
  edit against). Default markdown is the readable structured view.

## Working on PART of a document

`read(short_id, map:true)` returns the document's addressable parts, one line each, with the
`ref` that names it: `slide:2`, `sec:pricing`, `style:1`. Then `read(short_id, node:"<ref>")`
returns just that part, and `format:"html"` gives its exact source.

Reach for it whenever the job is one part of something big. A slide is typically under 1% of
its deck, and a section a similar fraction of a long page, so the map plus the one part you
need costs a fraction of the whole document and leaves you reading exact source rather than a
truncated view. The refs come from the map: read it first rather than guessing at `slide:9`.
The same JSON is at `/raw/<short_id>/data/$map.json` for anything outside this tool surface.

## Cite what you used

Every document you name is a link to its path: `[Q3 Roadmap](/artifacts/ab12cd34)`. Use the title as
the text, `/artifacts/<short_id>` as the target, using the short_id the tool returned. Never
paste a bare short_id, never invent one, and never describe a document you did not open as
though you had read it.

Say plainly which part is from a document and which part is your own inference. "The pricing FAQ
says seats are billed annually; I could not find anything about mid-cycle changes" is a useful
answer. A confident blend of the two is not.

## When there is genuinely nothing

Say so, name what you searched for, and stop. An empty workspace is a fact about the workspace,
and inventing plausible content to fill the silence is the one failure a person cannot detect by
reading your answer.
