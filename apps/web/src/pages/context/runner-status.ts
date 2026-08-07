import { BUILDER_COPY } from "./builder-copy"

export const runnerStatus = (seenAt: string | null) => {
  const age = seenAt ? Date.now() - new Date(seenAt).getTime() : Number.POSITIVE_INFINITY
  const online = age < 90_000
  return {
    age,
    online,
    away: !online && age < 600_000,
    title: online
      ? BUILDER_COPY.statusOnline
      : seenAt
        ? BUILDER_COPY.statusOffline
        : BUILDER_COPY.statusNever,
  }
}
