/** `https://<host>`, on the app's scheme (http on a plain local self-host). */
export const hostUrl = (baseUrl: string, host: string): string => {
  let scheme = "https:"
  try {
    scheme = new URL(baseUrl).protocol
  } catch {}
  return `${scheme}//${host}`
}
