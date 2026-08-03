// How strong a Slack→Derive identity is, and what that entitles it to.
//
// Two things can put a row in `slack_user_link`, and they are not the same claim:
//
//   oauth  somebody completed Slack sign-in and proved control of the Derive account.
//   email  their Slack profile address matched a member (lib/slack-mention.ts, which added it
//          so that answering in Slack would not require a detour through Settings).
//
// `getSlackUserLinkBySlackId` returns both, filtering only `miss`, and until now every
// Slack-originated authority treated them identically. That is defensible for READING — the
// email is one the workspace's own directory verified, and membership is checked separately, so
// a match with no seat is nobody. It is not defensible for WRITING, because the thing an
// attacker needs is different in kind: setting a Slack profile email (normally verifiable only
// with the mailbox, but settable by an admin through SCIM without one) would otherwise let
// somebody approve a publish, settle a review, or comment under another person's name.
//
// So: email resolves WHO you probably are, and oauth is what lets us act as you.
//
// The split has to be applied at EVERY lane at once or it is theatre. A button that refuses an
// email identity while the chat turn beside it will publish on the same row has not tightened
// anything — it has just moved where you ask. That is why the chat lane clamps its seat here
// rather than growing a check of its own.

import type { Role, SlackUserLinkRecord } from "@derive/core"

/** Did this person prove control of the Derive account, rather than merely match its address? */
export const isVerifiedLink = (link: SlackUserLinkRecord | null | undefined): boolean =>
  link?.origin === "oauth"

/** What to say when a write is refused for want of a deliberate link. Actionable on purpose:
 *  the fix is thirty seconds away and the person is one click from it, so the refusal names the
 *  place rather than the policy.
 *
 *  Takes the link because the two people this refuses are not in the same position. To somebody
 *  we matched by email, the second sentence is the whole point: we just answered their question
 *  by name, and a bare "connect your accounts" would read as though we had forgotten them. To
 *  somebody we cannot place at all it would be a lie, so they do not get it. */
export const linkToActMessage = (what: string, link?: SlackUserLinkRecord | null): string =>
  `Connect your Slack and Derive accounts (Settings → Integrations) to ${what} from Slack.` +
  (link ? ` We can see who you are from your email, but acting as you needs the link.` : "")

/** The seat a chat turn may act at.
 *
 *  An email-matched asker is clamped to `viewer`, which is the whole enforcement: the chat
 *  tools take their ceiling from the seat, and `publish` refuses a viewer on its own. No policy
 *  layer, no tool list to keep in step — the same mechanism that already stops a real viewer's
 *  chat from publishing. Reading, finding and catching up are untouched, so the reason email
 *  exists at all (answering a question without a detour) still works for anyone.
 */
export const chatSeatFor = (verified: boolean, seat: Role): Role => (verified ? seat : "viewer")
