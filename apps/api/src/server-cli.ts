import { join, resolve } from "node:path"

const [command = "serve", ...args] = process.argv.slice(2)

try {
  if (command === "serve") await import("./node")
  else {
    // Match node.ts's zero-friction local .env behavior for administrative
    // commands. The serve path deliberately lets node.ts load the file after it
    // snapshots the remote-database escape hatch, so .env cannot enable it.
    for (const envPath of [join(import.meta.dirname, "../../../.env"), resolve(".env")]) {
      try {
        process.loadEnvFile(envPath)
        break
      } catch {
        // Deployments normally inject the environment; no local file is expected.
      }
    }

    const { runAdminCommand } = await import("./admin")
    process.stdout.write(`${await runAdminCommand(command, args)}\n`)
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
