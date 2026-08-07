/**
 * Preserve the exact artifact deep link when an anonymous request is gated and
 * bounced through sign-in. The login route validates this same-origin relative
 * value before using it, then hard-navigates back after any auth method completes.
 */
export const artifactLoginSearch = (location: Pick<Location, "pathname" | "search">) => ({
  return_to: `${location.pathname}${location.search}`,
})
