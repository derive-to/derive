# Customer import rollout: current status

> Official Derive example with illustrative data. The company, people, results, and dates are
> fictional.

- **Owner:** Customer operations
- **Status:** Pilot
- **Updated:** 17 August 2026
- **Current focus:** Fix inconsistent date headers before opening the importer to every account.

## Current picture

Eight pilot files have been processed. Seven completed without help. One stopped because its
date column used a header the importer did not recognize. No imported records were lost or
duplicated in the pilot checks.

| Workstream | Current state | Owner | Next action |
| --- | --- | --- | --- |
| File validation | Common CSV errors are caught before import | Engineering | Add aliases for the three date headers found in pilot files |
| Error messages | Row-level errors include the column and expected format | Product | Test the wording with two support specialists |
| Recovery | Failed imports can restart without duplicating completed rows | Engineering | Run the 100,000-row recovery test |
| Support guide | Draft covers file format, retry, and escalation | Support | Add screenshots from the release candidate |

## Since the last update

- Added a preview that shows how five sample rows will map before an import starts.
- Fixed duplicate records caused by retrying after a browser timeout.
- Paused the wider rollout after the unrecognized date header in pilot file eight.

## Risks

| Risk | Signal | Owner | Next action |
| --- | --- | --- | --- |
| Large files time out | The 100,000-row test takes longer than ten minutes | Engineering | Profile parsing and database writes before raising the file limit |
| Header variations create avoidable failures | A pilot file uses a header outside the supported alias list | Product | Review anonymized header samples from the next five pilots |
| Support cannot diagnose a failed import | An error reaches support without an import ID | Support | Verify the ID appears in the UI and downloaded error file |

## Decisions needed

- Keep the public file limit at 25,000 rows until the recovery test passes.
- Decide whether unsupported headers should stop the import or open a mapping step.

## Next update

Update this report after the recovery test and the next five pilot imports. Replace the
summary instead of appending a diary, and keep completed decisions only when they explain the
current state.
