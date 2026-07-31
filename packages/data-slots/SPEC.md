# Data slots: the read contract

**Status: draft, prototype.** Nothing here is published as a standard yet, and it should not
be until somebody outside the team emits a slot. Publishing a spec for a format nothing
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
A version may carry named **slots**: JSON values, addressed by `(record, version, slot)`.

The version IS the time axis. There is no separate timestamp dimension to design, and no
write path other than publishing a version. That constraint is load-bearing: it is why this
costs one table instead of a subsystem, and why a data point can never disagree with the
document that produced it.

## 2. Emission (the write syntax)

Data lives inside the document, in a block the page carries anyway.

HTML — an inert script block, invisible in every browser:

```html
<script type="application/derive-data" data-slot="checks">
{"pass": 44, "fail": 0}
</script>
```

Markdown — a fence whose info string names the slot:

````markdown
```derive-data checks
{"pass": 44, "fail": 0}
```
````

Rules, all of which degrade to advisories and **never** block a write:

| Thing | Rule |
| --- | --- |
| Slot name | `[a-z0-9][a-z0-9-]{0,63}`, lowercase, never silently normalized |
| Body | valid JSON of any shape |
| Size | 32 KiB per slot, counted in **bytes**, not characters |
| Count | 20 slots per version; extras dropped, named in the advisory |
| Duplicate name | first occurrence wins |
| Carrier | single-file HTML or Markdown |

**The `</script>` hazard is normative, not incidental.** HTML ends a script block at the
first literal `</script>`, whatever a JSON string wanted, and a browser does the same. An
implementation MUST detect the truncation and say so specifically. Reporting "invalid JSON"
sends an author hunting in the wrong place: the JSON they are looking at *is* valid.

## 3. Reads

### 3.1 One value
`(record, slot)` on the current version; `(record, version, slot)` to pin one.

### 3.2 A series
`(record, slot, version-range)` returns one point per version **that carries the slot**,
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

## 4. Visibility

> **A derived read is never more readable than its source.**

The scope of a cross-record read is not an access check. A record can be restricted *within*
its own scope, so a host MUST narrow results through the same gate its ordinary search uses,
and MUST do so before returning **or counting** anything.

> **Aggregates disclose. Gate first, then count.**

A count computed over records the caller cannot see reveals their existence as surely as
naming them. `slots: 7` when the caller may read six is a leak.

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

Extraction happens at write time, so a slot added to a record with existing versions would
start its series that day and silently lose everything before it. A host SHOULD, on a
slot's first appearance, walk back through earlier versions and extract it from documents
that already carried the block. Bound the walk, and say when the bound stopped it.

**And the harder half.** None of the above matters if nothing emits. Every dead convention
in this space had good querying; what they lacked was a consumer that *rewarded* publishing
at the moment of publishing. A host SHOULD make emitting a slot pay immediately and
visibly: the share card carrying the record's own numbers, the review diff showing them
move, the write acknowledging what it stored. That is a claim this project is currently
testing, not a settled result.

---

## What is deliberately NOT here

- **A query language.** They do not travel. Expose surfaces people already hold.
- **Server-side aggregation or joins.** At these sizes a client does the arithmetic for less
  than the cost of designing, versioning and defending an aggregate API — and the moment a
  host runs user queries it inherits a DoS surface and a cost curve.
- **Mandatory schemas.** Ceremony killed CSVW. Optional, opt-in, or not at all.
- **Auto-extraction of tables.** Guessing at the meaning of someone's numbers produces
  confidently wrong data, which is worse than none.
