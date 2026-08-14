# Growth measurement

Derive measures whether public work starts a durable review loop. It does not add a
third-party page-view tracker, fingerprint visitors, or optimize for traffic without an
outcome.

## The funnel

1. **Useful arrival:** a person opens a public artifact, guide, example, or campaign URL.
2. **Intent:** they copy an agent setup prompt, open an official example, request beta
   access, or choose sign-in.
3. **Activation:** someone other than the owner opens a published artifact. The artifact's
   `first_foreign_view_at` records this once.
4. **Collaboration:** a reviewer leaves attributable feedback and the author or agent
   publishes a revision.
5. **Decision:** a named review round is approved.
6. **Retention:** the same workspace returns to publish and complete another review loop.

The primary product measure is **workspaces completing a second approved review loop**.
Signup volume is diagnostic; retained completed work is the outcome.

## Cookieless first-party attribution

Public signup links carry a bounded source token, optional artifact short id, and coarse
landing path in their query string. Beta access emails carry the same explicit handoff.
After authentication, the app submits it once during a short account-creation window and
`signup_attribution` keeps the first write. There is no attribution cookie, browser storage,
fingerprint, raw referrer, or third-party request; abandoning or reloading the flow may lose
attribution, which is the intended privacy tradeoff.

Each source token is stable, lowercase, and names a surface rather than copy that may
change. Current public-site tokens include:

| Token | Intent |
| --- | --- |
| `hero_agent_prompt` | Selected the homepage agent setup prompt during the same page view |
| `homepage_example` | Opened the homepage proof artifact |
| `copy_skill`, `copy_mcp`, `copy_draft` | Copied a concrete setup/publish command |
| `homepage_waitlist`, `pricing_waitlist` | Submitted a beta access form |
| `pricing_cta` | Chose a pricing-tier access CTA |
| `nav_signin`, `examples_signin` | Entered the account flow |
| `docs_nav`, `docs_home`, `docs_hosted` | Entered the hosted product from docs.derive.to |
| `official_examples` | Opened a live official artifact from the examples page |

Campaign URLs use the same bounded `src` parameter, for example
`https://derive.to/?src=hn-launch`. Do not put personal data, free-form copy, or channel
secrets in a source token.

## Reading the evidence

`signup_attribution` answers which explicit surface or campaign handed off to account
creation. Organic signups have no row by design. Join it to the auth user and workspace
membership only in a restricted operator query; never expose user identities in a public
dashboard.

For decisions, compare cohorts on the product outcomes above:

- signup → first external view;
- first external view → first comment;
- first comment → first revision;
- revision → named approval;
- first approved loop → second approved loop.

Report counts and conversion rates by source and signup month. Suppress tiny cohorts when
sharing externally. A source that produces fewer signups but more second approved loops is
the stronger channel.

## Experiment discipline

Write the hypothesis, primary outcome, guardrail, and stopping rule before changing a
surface. Change one important promise or interaction at a time. Keep source tokens stable
across copy variants, and record the variant separately in the experiment note. Do not
claim causality from a small, unrandomized cohort; label directional findings as such.
