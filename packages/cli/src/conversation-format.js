export const RUNNER_PROTOCOL_VERSION = 1

/** The tmux session an interactive task's harness runs in; the runner starts it and
 *  `derive attach` joins it. */
export const SESSION_TMUX = "derive"

/** A follow-up that only reopens a paused session: the runner resumes the conversation and
 *  sends no message. */
export const SESSION_RESUME = "Resume the session."

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

/** A task's options beyond its message, stored on its job: `session` runs the agent's own
 *  harness interactively in tmux for a person to attach to; `repo` (`owner/name[@ref]`) is
 *  checked out before the harness starts. Shared by the API, which stores and checks them,
 *  and the CLI, which sends them. */

/** `owner/name` or `owner/name@ref`, as GitHub names a repository and a branch, tag, or sha. */
export const TASK_REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}(@[A-Za-z0-9_./-]{1,200})?$/

/** Read a task's options from its job meta_json; anything else in it is ignored. */
export const taskOptions = (metaJson) => {
  if (!metaJson) return {}
  let raw
  try {
    raw = JSON.parse(metaJson)
  } catch {
    return {}
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  return {
    ...(raw.session === true ? { session: true } : {}),
    ...(typeof raw.repo === "string" && TASK_REPO.test(raw.repo) ? { repo: raw.repo } : {}),
  }
}
