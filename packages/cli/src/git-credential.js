// Git's credential-helper protocol. Nothing is written to disk, including on "store".
// Only an active Derive attempt can exchange its capability for a repository credential.
if (process.argv[2] === "get") {
  try {
    let input = ""
    for await (const chunk of process.stdin) {
      input += chunk.toString()
      if (input.length > 16384) throw new Error("Invalid Git credential request")
    }
    const fields = new Map()
    for (const line of input.split("\n")) {
      if (!line) continue
      const at = line.indexOf("=")
      if (at < 1 || fields.has(line.slice(0, at))) throw new Error("Invalid Git credential request")
      fields.set(line.slice(0, at), line.slice(at + 1))
    }
    const repository = (fields.get("path") ?? "").replace(/\.git$/, "")
    if (
      fields.get("protocol") !== "https" ||
      fields.get("host") !== "github.com" ||
      !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repository) ||
      repository.split("/").some((p) => p === "." || p === "..")
    )
      process.exit(0)
    if (!process.env.DERIVE_ATTEMPT_URL || !process.env.DERIVE_TOKEN)
      throw new Error("No active attempt")
    const response = await fetch(`${process.env.DERIVE_ATTEMPT_URL}/git-credential`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: {
        Authorization: `Bearer ${process.env.DERIVE_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ repository }),
    })
    if (!response.ok) throw new Error("Credential unavailable")
    const credential = await response.json()
    if (
      credential.username !== "x-access-token" ||
      typeof credential.password !== "string" ||
      !credential.password ||
      credential.password.length > 2048 ||
      /[\r\n\0]/.test(credential.password)
    )
      throw new Error("Invalid credential")
    process.stdout.write(`username=x-access-token\npassword=${credential.password}\n\n`)
  } catch {
    process.stderr.write(
      "Derive: GitHub access is unavailable. Check workflow repository access and the GitHub installation.\n",
    )
    process.exitCode = 1
  }
}
