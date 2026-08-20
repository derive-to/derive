// The status checks main's ruleset must require, in one place.
//
// Two scripts care about this list and they must never disagree:
// check-repository-health.mjs ASSERTS it (a scheduled audit, since public GitHub
// settings do not live in Git), and set-required-checks.mjs APPLIES it. Keeping
// the value in one module is the difference between "the audit caught the drift"
// and "the audit and the applier drifted apart and neither noticed".
//
// WHY `gate` AND NOT THE INDIVIDUAL CI LANES. GitHub's rule is that a skipped job
// "will report its status as Success. It will not prevent a pull request from
// merging, even if it is a required check." So any job named here becomes a
// vacuous gate the moment it acquires a job-level `if:` — a deleted merge gate
// with nothing failing to say so. `gate` in .github/workflows/ci.yml runs
// unconditionally, reads every lane's result itself, and accepts only success or
// skipped, so requiring exactly one context is both sufficient and impossible to
// satisfy by absence. `analyze` is CodeQL, which carries no such condition.
export const REQUIRED_CONTEXTS = ["analyze", "gate"]

/** The ruleset id for `main`. Discovered by name when absent, so this stays
 *  correct if the ruleset is ever recreated. */
export const RULESET_NAME = "Main branch"
