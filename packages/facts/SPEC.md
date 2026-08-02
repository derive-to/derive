# Facts: the read contract

**Status: draft, prototype.** Nothing here is published as a standard yet, and it should not
be until somebody outside the team emits a fact. Publishing a spec for a format nothing
emits is precisely how CSVW and the W3C Web Annotation model died, and both were better
specified than the things that beat them.

This document exists because the *parser* turned out to be the least valuable part of the
package. It is a few hundred lines, has no incumbent to displace, and there is nothing in
it an implementer would plausibly get wrong. The difficulty lives entirely in the contract
around it — and every item below is a decision an independent host must make, where the
wrong choice fails **silently**.

That is not hypothetical. This host got the visibility rule wrong on its first attempt,
with a correct example two hundred lines away in the same repository, and shipped a
cross-record read that returned the titles and figures of documents the caller had
deliberately been excluded from. Every test passed. If we could get it wrong here, an
independent implementer will get it wrong there.

---

## 1. The model

A **record** has an ordered, immutable series of **versions**. Each version is a document.
A version may carry named **facts**: JSON values, addressed by `(record, version, name)`.

The version IS the time axis. There is no separate timestamp dimension to design, and no
write path other than publishing a version. That constraint is load-bearing: it is why this
costs one table instead of a subsystem, and why a data point can never disagree with the
document that produced it.

## 2. Emission (the write syntax)

Data lives inside the document, in a block the page carries anyway.

HTML — an inert script block, invisible in every browser:

```html
<script type="application/derive-facts" data-fact="checks">
{"pass": 44, "fail": 0}
</script>
```

Markdown — a fence whose info string names the fact:

````markdown
```derive-facts checks
{"pass": 44, "fail": 0}
```
````

Rules, all of which degrade to advisories and **never** block a write:

| Thing | Rule |
| --- | --- |
| Fact name | `[a-z0-9][a-z0-9-]{0,63}`, lowercase, never silently normalized |
| Body | valid JSON of any shape |
| Size | 32 KiB per fact, counted in **bytes**, not characters |
| Count | 20 facts per version; extras dropped, named in the advisory |
| Duplicate name | first occurrence wins |
| Carrier | single-file HTML or Markdown |

**Older spellings MUST keep parsing.** This shipped as `application/derive-data` /
`data-slot` before the name settled, and a version is immutable: documents already
published carry the old bytes and nothing may rewrite them. An implementation accepts both
forever — it costs one membership test — and teaches only the current spelling to new
writers. Dropping the old form would silently empty the history of anything published
early, which is §3.2's prohibition on fabricated gaps arriving from the other direction.

(The rename itself is worth one line of rationale, since a spec that changes a name owes
the reason: `data-slot` already means *a named placeholder that content is injected into*
in Web Components, Vue and Svelte — the exact inverse of a block that IS content. It also
collided inside the reference host's own repo, where the UI kit puts `data-slot` on every
card and dialog.)

**The `</script>` hazard is normative, not incidental.** HTML ends a script block at the
first close tag, whatever a JSON string wanted, and a browser does the same. An
implementation MUST detect the truncation and say so specifically. Reporting "invalid JSON"
sends an author hunting in the wrong place: the JSON they are looking at *is* valid.

**And the close-tag grammar is the browser's, not the literal string.** A browser ends the
element at `</script` followed by whitespace, `/`, or `>` — so `</script >` and
`</script foo>` terminate it too. An implementation that matches only the literal
`</script>` reads past a close the browser honors, and the two silently disagree about
where a body ends. This clause exists because the reference implementation itself got it
wrong, and only an external scanner re-reading moved code caught it: match the browser's
grammar, and test against `</script >` specifically.

## 3. Reads

### 3.1 One value
`(record, slot)` on the current version; `(record, version, slot)` to pin one.

### 3.2 A series
`(record, slot, version-range)` returns one point per version **that carries the fact**,
oldest first.

> **A version carrying no value is ABSENT. It is never a null, a zero, or a gap filled in.**

This is the single most tempting place to be helpful and the most damaging. A chart drawn
from fabricated zeroes is indistinguishable from a chart of a real collapse. The response
MUST report how many points it returned so a caller can tell "no data" from "no matches",
and it MUST cap the series and hand back the range to ask for rather than truncating in
silence.

### 3.3 Across records
`(scope, slot)` returns that slot from every record in scope.

> **Each row MUST be joined to that record's CURRENT version.**

Reading the latest *slot row* instead is the natural implementation and it is wrong: it can
report a superseded value as the present state, which is the failure mode that makes the
whole surface quietly untrustworthy rather than visibly broken.

### 3.4 Partial reads of one version

Structured facts are not the only read this layer owes. A version is often too large to
hand to an agent whole, so the same addressing story extends INTO a document: an
**outline** (headings, or landmark regions for a headless page), a **named section**, a
**line window**. A reader should be able to spend tokens proportional to the part it
needs, not to the document that contains it.

Three rules, same spirit as the rest:

- **A partial read obeys §4 unchanged.** An outline, a section map, or a search snippet is
  derived from the source and is never more readable than it.
- **Derived views are recomputable, so they may be cached content-addressed** — keyed by
  the source hash plus a generation number, and the generation MUST be bumped on any
  change to the deriving code, or stale views serve forever. (Facts are NOT this: they are
  canonical rows that must survive any eviction. Different lifecycle, different store.)
- **Measure before caching.** The cost of recomputing a derived view is an empirical
  number, not an intuition; this host ships a per-read timing probe and gates its own
  cache PR on what the probe says. A cache nobody needed is a generation-bump discipline
  paid forever for nothing.

### 3.5 The inverse read

Every read above is *per record*: this page's value, this page's history, this metric
everywhere. The questions a corpus actually gets asked have the other shape — what points
HERE, which documents carry this name — and each is an **inversion** of a per-record index.
A host MAY expose one, under four conditions.

- **One predicate, one bound parameter, never an expression.** An inversion is a named
  question with a fixed shape, not a query language by another route (§"What is deliberately
  NOT here"). The moment a caller can compose it, the host has inherited a cost curve.
- **§4's gate applies to the LINKING records, not to the target.** A backlink row names the
  document that made the reference, so an invisible linker MUST NOT appear — but the target
  itself needs no permission, because the caller learns nothing the linker does not already
  disclose. The target's EXISTENCE must not be confirmable either: "nothing links here",
  "the linkers were never indexed", and "no such record" MUST be indistinguishable, or the
  inversion is an existence oracle for every id on the host.
- **It is exhaustive within its index, or it says so.** The only reason to build an
  inversion is that ranked search under-reports; one that silently truncates has kept the
  defect and added a cache. Report a scan bound, which is caller-independent and so
  discloses nothing. Never report a visibility filter, which is neither.
- **It SHOULD NOT be materialized until measurement says reads exceed rebuilds.** An
  inversion computed from the rows it inverts cannot disagree with them. A second table can,
  and nothing will ever compare the two.

Build one only when the scan it replaces is a query people actually run. The client-side
inversion is the evidence, and it is also the thing to beat: pulling every record's rows to
fold them locally is bounded by the read cap, so it is not merely slower than a server-side
inversion but less complete.

## 4. Visibility

> **A derived read is never more readable than its source.**

The scope of a cross-record read is not an access check. A record can be restricted *within*
its own scope, so a host MUST narrow results through the same gate its ordinary search uses,
and MUST do so before returning **or counting** anything.

> **Aggregates disclose. Gate first, then count.**

A count computed over records the caller cannot see reveals their existence as surely as
naming them. `facts: 7` when the caller may read six is a leak.

> **Never report what was filtered.**

"Some results were hidden" is itself the disclosure. Over-fetch and cut instead, so a page
of invisible records cannot make a real answer look like an empty one.

## 5. Export

The interop boundary is **JSONL**: one JSON object per version, oldest first.

```
{"n":1,"at":"2026-06-30T…","data":{"pass":41}}
{"n":2,"at":"2026-07-01T…","data":{"pass":42}}
```

A new version is a line append, so the file streams and stays cheap to poll. Anything that
reads JSONL is already a client, which is most things.

### 5.1 Verified against a real query engine

The claim "a host wanting SQL does not need the host's help" was an assertion until it was
run. It holds, and the measurement is worth recording because it is the entire justification
for refusing to build server-side aggregation.

DuckDB was pointed straight at the live export URL with **no extension install, no download
step, and no host involvement**:

```sql
SELECT n, data.pass, data.pass - lag(data.pass) OVER (ORDER BY n) AS delta
FROM read_json_auto('https://…/raw/<id>/data/checks.jsonl') ORDER BY n
```

- The shape needs no massaging. `n` infers as BIGINT, `at` as **TIMESTAMP**, and the payload
  as a typed `STRUCT(run BIGINT, pass BIGINT, fail BIGINT)`, so `data.pass` just works.
- **Shape drift across versions is handled**, which is the realistic case rather than the
  happy one. Across a series where v8 added a `flaky` array and v9 dropped `fail`, the union
  schema came back as `STRUCT(run, pass, fail, flaky VARCHAR[])`, missing fields read as
  NULL rather than raising, and `count()` correctly reported 8 of 9 rows carrying `fail` and
  1 of 9 carrying `flaky`.
- **Nothing fabricates zeroes.** An engine that never read §3.2 honours its rule anyway,
  because absence in JSON is absence. That alignment is the reason the rule is cheap to keep.
- **Several records union into one table.** `read_json_auto([url1, url2, url3],
  filename=true)` makes a workspace queryable in one statement: group by artifact, window
  over versions, rank by latest value. This is exactly the cross-record aggregation a host
  is tempted to build, obtained for free by publishing files.

Two caveats a host should know rather than discover:

- The export SHOULD advertise `Accept-Ranges`. Without it an engine falls back to reading
  the whole file. Harmless at a few KB; it is not harmless at a few MB.
- `read_json_auto` infers from a **sample**. A field that first appears very late in a long
  series can be missed, and the fix is the reader's (`sample_size=-1`), not the host's —
  but the failure looks like missing data, so say it out loud.

### 5.2 In the page, in a sandbox: also verified

§5.1 was run from Node, which is the easy environment. The interesting claim is SQL **in
the document**, and the sandbox is where every constraint lives. So it was run there too:
`examples/duckdb-in-page.html`, loaded in a real browser, screenshot in
`examples/duckdb-in-page.png`.

Every step of the hostile path worked from inside an opaque origin:

1. A cross-origin ESM import of duckdb-wasm from a CDN.
2. A **Web Worker spawned from a blob URL** — the step most likely to be refused by a
   sandbox, and the one worth checking before promising anyone SQL in a page.
3. `registerFileURL(…, HTTP)` against the record's own export, then `read_json_auto` over
   it: ten versions, no fetching by hand.
4. A window function computing per-version deltas, entirely in the browser.

So the requirement really is only §6.1's three conditions plus a CDN reachable from the
page. The host contributes a static file and a CORS header, and never sees the query.

**And the engine confirmed the caveat above in its own words.** The console carried exactly
one warning:

```
falling back to full HTTP read for: …/data/checks.jsonl
```

DuckDB attempted range requests, the export did not advertise `Accept-Ranges`, and it
degraded to a whole-file read rather than failing. That is the good failure mode, and it is
also the argument for fixing it before a series gets large.

## 6. Serving (learned the hard way)

These are not theory. Each one was a live defect.

- **A version-pinned response may be cached immutably. A current-version alias may not**,
  because the next publish changes what it points at.
- **A response assembled for one caller MUST NOT be shared-cacheable.** If the body varies
  by who asked and nothing varies on the credential, `public` invites a CDN to hand one
  reader's data to another. Gated records get browser-private caching; only a
  world-readable record keeps the hard shared cache.
- **The data MUST be readable by the record's own page.** If documents render in a sandbox
  (an opaque origin, as they should), a page fetching its own data is cross-origin from a
  null origin and needs a permissive CORS header — otherwise `fetch` throws before any
  response is visible and "a page charts its own history" is fiction. This grants no
  access: an opaque origin cannot send credentials, so a cross-origin caller sees exactly
  what an anonymous one sees.
- **Therefore self-reading works only for world-readable records.** A gated record's page
  has no credentials to prove with, and no header changes that. Say so plainly rather than
  shipping an example that cannot run.

### 6.1 The three conditions for a self-reading page

Demonstrated end to end against a live server (`examples/self-charting.html`), because the
first two are invisible until you try it, and a host that documents only the third ships an
example that returns one data point and looks broken.

| # | Condition | If missing |
| --- | --- | --- |
| 1 | The record's **world link** grants read | `fetch` gets 404 — an opaque origin sends no credentials |
| 2 | **Public history** is enabled on the record | The series returns **exactly one point**, the current version |
| 3 | The data response carries **CORS** | `fetch` throws before any response is visible |

Condition 2 is the one nobody predicts. A history export MUST NOT become a way around
whatever gate guards a record's older versions, so the correct behaviour for an anonymous
caller on a record that has not opted into public history is to serve the current value
only. That is right, and it means **a public record's own page charts a single point by
default**. Measured on a six-version record: anonymous read returned 1 line, the authorized
read returned 6, and enabling public history made the anonymous read return 6.

A host SHOULD say which condition is missing rather than failing blank. "HTTP 404 — this
record needs a world link" and "one point: enable public history to chart the series" are
both one-line fixes; a bare `TypeError: Failed to fetch` is an afternoon.

## 7. Adoption

Extraction happens at write time, so a fact added to a record with existing versions would
start its series that day and silently lose everything before it. A host SHOULD, on a
slot's first appearance, walk back through earlier versions and extract it from documents
that already carried the block. Bound the walk, and say when the bound stopped it.

**And the harder half.** None of the above matters if nothing emits. Every dead convention
in this space had good querying; what they lacked was a consumer that *rewarded* publishing
at the moment of publishing. A host SHOULD make emitting a fact pay immediately and
visibly: the share card carrying the record's own numbers, the review diff showing them
move, the write acknowledging what it stored. That is a claim this project is currently
testing, not a settled result.

## 8. Derived facts (the `$` namespace)

A host MAY compute facts of its own from a version's bytes — an outline, the outbound
links, size counts — and serve them through the same read surfaces. These are **derived
facts**, and the contract treats them as a second class of truth:

> **An asserted fact is testimony: it means something because the author said it, pinned
> to the version where they said it. A derived fact is verification: anyone can recompute
> it from the bytes. An implementation MUST never let the two blur.**

Rules, all normative:

- **The namespace is structural.** Derived names carry the `$` prefix, which the authored
  name grammar (§2) already rejects — so no author block can claim a derived name and no
  derived output can impersonate an author. A host inventing a different marker MUST pick
  one outside the authored grammar for the same reason.
- **Derivation is transcription, never interpretation.** Counting words is derivation.
  Extracting an outline is derivation. Deciding what a number *means*, which table cells
  are metrics, or a document's status is testimony only its author can give — a host that
  wants those SHOULD propose them to the author and store only what the author publishes.
- **Derived facts are recomputable, and everything follows from that.** They MAY be
  evicted, regenerated, or versioned by the generation of the deriving code; a stale or
  missing derived row is a cache miss, not data loss. Asserted rows MUST never be treated
  this way.
- **A generation belongs to ONE deriver, not to the host.** Versioning derived output with
  a single shared constant makes a change to any deriver invalidate every other deriver's
  rows across the whole corpus. That is affordable for a reader that can recompute on the
  fly and ruinous for one that cannot — a consumer reading across records is bounded away
  from compute (§4's crawler rule), so its only remaining choices are serving stale output
  or serving none. Each derived row therefore SHOULD carry the generation of the code that
  produced THAT row.
- **A `$name` the host no longer computes MUST stop being served.** A retired deriver's
  rows are the one derived state that never self-corrects: they match nothing, nothing
  rewrites them, and they read as current forever. A generation that no live deriver
  claims MUST NOT compare equal to a stored row's.
- **Derived facts MUST NOT count.** Not toward adoption metrics, not in publish
  acknowledgments, not in author-facing advisories or reward surfaces (share cards,
  review diffs). The reward channel exists to pay authors for asserting; a host that
  congratulates itself through it destroys the signal.
- **Same visibility, same absence rules.** A derived fact is derived from the source and
  is never more readable than it (§4); a version with no derived row is absent, never a
  fabricated zero (§3.2).

---

## What is deliberately NOT here

- **A query language.** They do not travel. Expose surfaces people already hold.
- **A query language, or server-side aggregation over caller-supplied expressions.** At
  these sizes a client does the arithmetic for less than the cost of designing, versioning
  and defending an aggregate API — and the moment a host runs user queries it inherits a
  DoS surface and a cost curve. Fixed-shape joins the contract itself requires are not this
  and never were: §3.3's current-version join is mandatory, and §3.5's inverse read is one
  predicate with one bound parameter and no arithmetic.
- **Mandatory schemas.** Ceremony killed CSVW. Optional, opt-in, or not at all.
- **Auto-extraction of tables.** Guessing at the meaning of someone's numbers produces
  confidently wrong data, which is worse than none.
