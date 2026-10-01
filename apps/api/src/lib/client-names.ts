import { type MetaStore, Recent } from "@derive/core"

/** An OAuth client's display name, remembered for ten minutes per process. Every request an
 *  OAuth or minted-token agent makes names its client, and on the edge that read is a round
 *  trip in front of the request's own work; a client's name is only ever shown. */
const seen = new Recent<string, { name: string | null; at: number }>(500)
const FRESH_MS = 10 * 60_000

export const clientName = async (
  meta: Pick<MetaStore, "getOAuthClientName">,
  clientId: string,
): Promise<string | null> => {
  const hit = seen.get(clientId)
  if (hit && Date.now() - hit.at < FRESH_MS) return hit.name
  const name = (await meta.getOAuthClientName(clientId)) || null
  seen.set(clientId, { name, at: Date.now() })
  return name
}
