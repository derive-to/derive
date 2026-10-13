/** A turn owns its process group. Cancellation must also stop its shell commands. */
export const terminateProcess = (child, signal = "SIGTERM") => {
  try {
    if (child.pid && process.platform !== "win32") process.kill(-child.pid, signal)
    else child.kill(signal)
  } catch {
    // A process that already exited needs no signal.
  }
}

export const clipped = (value, max = 300) =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)

export const safeCommand = (value) =>
  clipped(value, 200)
    .replace(
      /\b(dk[a-z_]*_[A-Za-z0-9_-]{12,}|sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,})\b/g,
      "[redacted]",
    )
    .replace(/\b([A-Z][A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD))=\S+/g, "$1=[redacted]")
    .replace(/(authorization\s*[:=]?\s*bearer)\s+\S+/gi, "$1 [redacted]")
