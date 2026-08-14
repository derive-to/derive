import { createReadStream, existsSync, statSync } from "node:fs"
import { createServer } from "node:http"
import { extname, resolve, sep } from "node:path"

const [rootArgument, portArgument] = process.argv.slice(2)
if (!rootArgument || !portArgument) throw new Error("usage: static-server.mjs <root> <port>")

const root = resolve(rootArgument)
const port = Number(portArgument)
if (!Number.isSafeInteger(port) || port < 1) throw new Error(`invalid port: ${portArgument}`)

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".webmanifest", "application/manifest+json"],
  [".woff2", "font/woff2"],
  [".xml", "application/xml; charset=utf-8"],
])

function resolveRequest(pathname) {
  const decoded = decodeURIComponent(pathname)
  const relative = decoded.endsWith("/") ? `${decoded}index.html` : decoded
  const direct = resolve(root, `.${relative}`)
  if (direct !== root && !direct.startsWith(`${root}${sep}`)) return null
  if (existsSync(direct) && statSync(direct).isFile()) return { path: direct, status: 200 }
  if (!extname(direct)) {
    const index = resolve(direct, "index.html")
    if (index.startsWith(`${root}${sep}`) && existsSync(index) && statSync(index).isFile())
      return { path: index, status: 200 }
  }
  const notFound = resolve(root, "404.html")
  return existsSync(notFound) ? { path: notFound, status: 404 } : null
}

const server = createServer((request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://localhost")
    const result = resolveRequest(url.pathname)
    if (!result) {
      response.writeHead(404).end("Not found")
      return
    }
    response.writeHead(result.status, {
      "cache-control": "no-store",
      "content-type": contentTypes.get(extname(result.path)) ?? "application/octet-stream",
    })
    if (request.method === "HEAD") response.end()
    else createReadStream(result.path).pipe(response)
  } catch {
    response.writeHead(400).end("Bad request")
  }
})

server.listen(port, "127.0.0.1", () => {
  console.log(`static preview: http://127.0.0.1:${port} → ${root}`)
})

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
