import type { NewSignupAttribution } from "@derive/core"

/**
 * Cookieless signup attribution. Public surfaces carry only a bounded source token,
 * optional artifact id, and coarse landing path in the explicit signup URL. The
 * browser submits those values once after authentication; nothing is persisted in
 * cookies, local storage, fingerprints, or third-party analytics.
 */

/** A campaign/surface token (`badge`, `comment_wall`, `hn-launch`) — never copy. */
export const SIGNUP_SOURCE_KIND = /^[a-z0-9][a-z0-9_-]{0,39}$/i
/** The artifact short-id shape recorded by the product. */
export const SIGNUP_SOURCE_ARTIFACT = /^[0-9a-z]{6,12}$/

export interface SignupSourceInput {
  source_kind: string
  source_artifact?: string | null
  landing_path?: string | null
}

const SIGNUP_WINDOW_MS = 30 * 60 * 1000
const CLOCK_SKEW_MS = 5 * 60 * 1000

/** Accept attribution only around account creation, not on an ordinary returning
 * login. `now` is injectable so the privacy boundary is deterministic in tests. */
export const isSignupAttributionWindow = (createdAt: string, now = Date.now()): boolean => {
  const age = now - Date.parse(createdAt)
  return Number.isFinite(age) && age >= -CLOCK_SKEW_MS && age <= SIGNUP_WINDOW_MS
}

/** Validate and minimize the explicit client handoff. Invalid optional values are
 * dropped; an invalid source rejects the whole record. Referrers are deliberately
 * not accepted because they are not needed to compare product activation cohorts. */
export const signupAttribution = (
  userId: string,
  id: string,
  input: SignupSourceInput,
): NewSignupAttribution | null => {
  if (!SIGNUP_SOURCE_KIND.test(input.source_kind)) return null
  const artifact = input.source_artifact
  const landing = input.landing_path
  return {
    id,
    user_id: userId,
    source_kind: input.source_kind.toLowerCase(),
    source_artifact:
      typeof artifact === "string" && SIGNUP_SOURCE_ARTIFACT.test(artifact) ? artifact : null,
    landing_path:
      typeof landing === "string" && landing.startsWith("/") && !landing.startsWith("//")
        ? landing.slice(0, 200)
        : null,
    referrer: null,
  }
}
