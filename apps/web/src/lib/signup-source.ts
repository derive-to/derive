const KIND = /^[a-z0-9][a-z0-9_-]{0,39}$/i
const ARTIFACT = /^[0-9a-z]{6,12}$/

export interface SignupSourceSearch {
  src: string
  landing: string
  art?: string
}

/** Build the explicit, cookieless handoff from a public intent surface to signup.
 * Values stay coarse and bounded because this object is visible in the URL. */
export const signupSourceSearch = (
  kind: string,
  artifact: string | null,
  landingPath: string,
): SignupSourceSearch => {
  if (!KIND.test(kind)) throw new Error("invalid signup source")
  const landing =
    landingPath.startsWith("/") && !landingPath.startsWith("//") ? landingPath.slice(0, 200) : "/"
  return {
    src: kind.toLowerCase(),
    landing,
    ...(artifact && ARTIFACT.test(artifact) ? { art: artifact } : {}),
  }
}
