# CSV importer: what changed and how it was checked

> Official Derive example. The change, the test data, and the results are illustrative. The
> structure is the point: what was claimed, what was actually run, and what is still unproven.

**Change:** Reject malformed rows instead of importing them as empty values
**Checked on:** A deploy preview, not a local machine
**Verdict:** Ready to merge, with one follow-up filed

## What changed

The importer used to accept a row whose date column could not be parsed, storing an empty
date and continuing. That turned a visible failure into a silent one: the import reported
success and the missing dates surfaced weeks later in reporting.

Now an unparseable required field stops the row, and the response names the row number, the
column, and the expected format.

## What was actually run

Everything below was run against the deploy preview with the seeded demo workspace, not on a
development machine. Local runs miss the object storage path, which is where the previous
version of this change broke.

| Check | Input | Expected | Result |
| --- | --- | --- | --- |
| Valid file, unchanged behaviour | 500 rows, all valid | 500 imported, no warnings | 500 imported |
| The reported bug | 1 row with `12/31/2025` under an ISO header | Row rejected, error names the column | Rejected, message reads `row 4: expected YYYY-MM-DD in "start_date"` |
| Mixed file | 200 rows, 6 malformed | 194 imported, 6 listed | 194 imported, all 6 listed with row numbers |
| Whole file malformed | 50 rows, every date wrong | Nothing imported, one summary | Nothing imported |
| Empty optional field | Optional note left blank | Accepted | Accepted |
| Re-import after fixing | The 6 rows corrected, file re-uploaded | 6 imported, no duplicates of the 194 | 6 imported, no duplicates |

## What broke while checking

The first attempt returned a 500 on the mixed file. The error collector held a reference to
the open file handle, so serialising the response after the stream closed threw. It is fixed
in the change under review, and the mixed-file case above is the regression test.

This is worth recording because the bug only appeared with a partial failure. A file that was
entirely valid or entirely broken never hit it.

## Not covered

- **Files above 10 MB.** The largest file tested was 2.1 MB. The streaming path is unchanged
  by this work, but "unchanged" is an argument, not a test.
- **Non-UTF-8 encodings.** A file exported from a spreadsheet in Latin-1 was not tried. The
  reported bug did not involve encoding, so this was out of scope, and it is a plausible
  next report.
- **Concurrent imports into one workspace.** Single-user testing only.

## Follow-up filed

The error list is capped at the first 100 malformed rows with no indication that it was
truncated. A user fixing a 900-row file will correct 100 problems, re-upload, and meet the
next 100. Filed separately rather than fixed here, because the fix is a pagination decision
and not part of stopping the silent failure.
