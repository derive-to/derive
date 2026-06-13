/**
 * A tiny structured logger. In production it emits one JSON object per line
 * (ready for a log pipeline); in development it prints a readable tagged line.
 * Use this instead of `console.*` so operational output stays consistent and
 * machine-parseable where it matters.
 */
type Level = "info" | "warn" | "error"

const isProd = process.env.NODE_ENV === "production"
const TAG: Record<Level, string> = { info: "·", warn: "⚠", error: "✖" }

const emit = (level: Level, msg: string, fields?: Record<string, unknown>): void => {
  const sink = level === "info" ? console.log : level === "warn" ? console.warn : console.error
  if (isProd) {
    sink(JSON.stringify({ level, msg, ...fields, time: new Date().toISOString() }))
  } else if (fields && Object.keys(fields).length) {
    sink(`${TAG[level]} ${msg}`, fields)
  } else {
    sink(`${TAG[level]} ${msg}`)
  }
}

export const log = {
  info: (msg: string, fields?: Record<string, unknown>) => emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit("error", msg, fields),
}
