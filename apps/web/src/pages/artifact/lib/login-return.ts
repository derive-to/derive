/**
 * Preserve the exact artifact deep link when an anonymous request is gated and the
 * visitor chooses Sign in. The login route validates this same-origin relative value
 * before using it, then hard-navigates back after any auth method completes.
 */
export const artifactLoginSearch = (location: Pick<Location, "pathname" | "search">) => ({
  return_to: `${location.pathname}${location.search}`,
})

/**
 * What the artifact route shows for a masked 404/403 (missing and private are the same
 * status by design — never leak which). Signed-out visitors get a path forward via
 * sign-in-with-return; signed-in visitors stay on a not-available page with no CTA that
 * would imply the doc exists under another account.
 */
export type ArtifactUnavailableView = {
  title: string
  description: string
  /** Present only for signed-out visitors — login search carries the return path. */
  signIn: { label: string; search: { return_to: string } } | null
}

export const artifactUnavailableView = (
  authed: boolean,
  location: Pick<Location, "pathname" | "search">,
): ArtifactUnavailableView => {
  if (authed) {
    return {
      title: "This page isn’t available",
      description:
        "It doesn’t exist, or you don’t have access. You may need to ask whoever shared it.",
      signIn: null,
    }
  }
  return {
    title: "This page isn’t available",
    description: "If someone shared it with you, signing in may help.",
    signIn: {
      label: "Sign in to view",
      search: artifactLoginSearch(location),
    },
  }
}
