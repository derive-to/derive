/**
 * IS THIS HREF A PLACE INSIDE DERIVE — the check that must run before any router navigation
 * built from text an agent produced.
 *
 * 🚨 `href.startsWith("/")` is NOT this check, and that is the whole reason this file exists.
 * `//evil.com` starts with a slash and is a PROTOCOL-RELATIVE URL: handed to the router (or set
 * as a location) it leaves the origin entirely. `/\evil.com` is the same trick, because browsers
 * normalise the backslash. Both look like in-app paths to a naive test and are not.
 *
 * That matters here more than in most places, because the strings being tested are written by a
 * MODEL that has just read documents — a teammate's page, a synced repo, an MCP source. Content
 * anybody can author reaches the model, and an answer's links are rendered as things to click and
 * lifted into rows to take. "Ask a question, get sent to a site somebody planted in a document" is
 * an open redirect with a prompt injection for a trigger, and it needs no bug in the model to
 * work: the model quoting its source faithfully is enough.
 *
 * Accepts a root-relative path only: one leading slash, no scheme, no host, no backslash after
 * the slash. Query and fragment are fine.
 */
export const isInAppPath = (href: string | null | undefined): href is string =>
  typeof href === "string" &&
  href.startsWith("/") &&
  !href.startsWith("//") &&
  !href.startsWith("/\\")
