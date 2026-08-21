# Growth measurement

Derive keeps a small set of first-party facts that help us understand how the product is
used. It does not add a third-party page-view tracker, fingerprint visitors, or pretend
that one sequence describes every useful workspace.

## Different uses stay different

These facts describe different product uses rather than steps in a required funnel:

- a workspace publishes artifacts;
- an artifact receives a later version;
- someone other than the author opens an artifact;
- a person leaves an attributable comment;
- a formal review records a named decision; and
- a workspace pays for editor seats.

A private library can be useful without an external view. A shared page can be useful without
a comment. A recurring report can be useful without a review round. Report these facts
separately and use conversations with users to understand what they mean. Do not combine them
into a universal score or call an action meaningful from event data alone.

## Cookieless first-party attribution

Only a link that explicitly hands a person into account creation carries a bounded
source token, optional artifact short id, and coarse landing path. After authentication, the
app submits it once during a short account-creation window and `signup_attribution` keeps the
first write. There is no attribution cookie, browser storage, fingerprint, raw referrer, or
third-party request; abandoning or reloading the flow may lose attribution, which is the
intended privacy tradeoff.

Page views and interest actions are deliberately not signup attribution. Opening an example,
copying a command, or reading the pricing page may show intent, but none of those actions is
stored unless the person later chooses a source-bearing account handoff.

Each source token is stable, lowercase, and names a surface rather than copy that may
change. Current public account-handoff tokens include:

| Token | Intent |
| --- | --- |
| `homepage_finale` | Chose the homepage's closing signup CTA |
| `pricing_free`, `pricing_team`, `pricing_business` | Chose a tier's signup CTA on the pricing page |
| `pricing_cta` | Chose the pricing page's closing signup CTA |
| `nav_signin`, `examples_signin` | Entered the account flow |
| `public_frame`, `make_your_own` | Chose the signup CTA on a public surface or artifact |
| `comment_wall` | Entered the account flow to leave attributable feedback |
| `badge` | Chose the Made with Derive signup CTA on a public artifact |

`homepage_waitlist` and `pricing_waitlist` are historical: they belonged to the beta
request-access forms, which were retired when the beta ended. Rows recorded under them
remain valid attribution.

Campaigns link directly into the same account handoff, for example
`https://derive.to/login?signup=1&src=hn-launch&landing=/`. A campaign parameter on an
intermediate page is not preserved. Do not put personal data, free-form copy, or channel
secrets in a source token.

## Reading the evidence

`signup_attribution` answers which explicit surface or campaign handed off to account
creation. Organic signups have no row by design. Join it to the auth user and workspace
membership only in a restricted operator query; never expose user identities in a public
dashboard.

For decisions, report the available counts separately by source and signup month. Suppress
tiny cohorts when sharing externally. Treat differences as prompts for investigation, not as
proof that one source or workflow is better. Read representative artifacts and talk to the
people using them before deciding what to change.

## Experiment discipline

Write the question, expected effect, guardrail, and stopping rule before changing a surface.
Change one important promise or interaction at a time. Keep source tokens stable across copy
variants, and record the variant separately in the experiment note. Do not claim causality
from a small, unrandomized cohort or turn a descriptive count into a universal success metric.
