/** A turn owns its process group. Cancellation must also stop its shell commands. */
export const terminateProcess = (child, signal = "SIGTERM") => {
  try {
    if (child.pid && process.platform !== "win32") process.kill(-child.pid, signal)
    else child.kill(signal)
  } catch {
    // A process that already exited needs no signal.
  }
}
