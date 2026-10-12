export const RUNNER_PROTOCOL_VERSION = 1

export const checkpointFileAllowed = (provider, session, file) => {
  if (
    !/^[a-zA-Z0-9_-]{1,200}$/.test(session) ||
    file.includes("\\") ||
    file.split("/").includes("..")
  )
    return false
  if (provider === "codex")
    return (
      /^sessions\/\d{4}\/\d{2}\/\d{2}\/rollout-[a-zA-Z0-9_.-]+\.jsonl$/.test(file) &&
      file.endsWith(`-${session}.jsonl`)
    )
  return (
    provider === "claude-code" &&
    /^projects\/[^/]+\/[^/]+\.jsonl$/.test(file) &&
    file.endsWith(`/${session}.jsonl`)
  )
}

export const checkpointProblem = (value) => {
  if (value.version !== 1 || !/^[a-f0-9]{64}$/.test(value.sha256))
    return "Unsupported checkpoint format."
  const entries = Object.entries(value.files)
  if (!entries.length || entries.length > 10) return "Unsupported checkpoint file count."
  if (
    entries.some(
      ([file, body]) =>
        typeof body !== "string" || !checkpointFileAllowed(value.provider, value.session_id, file),
    )
  )
    return "Only this conversation’s native files can be saved."
  if (new TextEncoder().encode(JSON.stringify(value.files)).length > 8_000_000)
    return "The conversation exceeds the checkpoint limit."
  return null
}
