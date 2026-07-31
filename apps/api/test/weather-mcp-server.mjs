// A real MCP server that reports real weather. No API key, no dependencies.
//
// Exists because there is no public no-auth weather MCP server to point Derive at, and the
// end-to-end proof wants data that VISIBLY CHANGES — a document that says 14°C today and 9°C
// tomorrow demonstrates a living artifact in a way a static wiki page cannot.
//
// Backed by Open-Meteo (open data, no key, no rate limit for this volume):
//   geocoding  https://geocoding-api.open-meteo.com/v1/search
//   forecast   https://api.open-meteo.com/v1/forecast
//
// Speaks MCP streamable HTTP: one POST endpoint, JSON-RPC in, JSON out. Two runtimes, one file:
//   node weather-mcp.mjs 8940      → http://localhost:8940/mcp   (local Derive dev accepts http://localhost)
//   wrangler deploy                → https://<name>.workers.dev/mcp (what a hosted preview needs)
//
// The default export is the Worker fetch handler; the Node bootstrap at the bottom only runs when
// executed directly.

const WMO = {
  0: "clear sky",
  1: "mainly clear",
  2: "partly cloudy",
  3: "overcast",
  45: "fog",
  48: "depositing rime fog",
  51: "light drizzle",
  53: "drizzle",
  55: "dense drizzle",
  61: "slight rain",
  63: "rain",
  65: "heavy rain",
  71: "slight snow",
  73: "snow",
  75: "heavy snow",
  80: "rain showers",
  81: "rain showers",
  82: "violent rain showers",
  95: "thunderstorm",
}

const TOOLS = [
  {
    name: "get_current_weather",
    title: "Current weather",
    description:
      "Current weather for a place, by name. Returns temperature in Celsius, wind speed in km/h, " +
      "a plain-language condition, and the observation time. Live data from Open-Meteo.",
    inputSchema: {
      type: "object",
      properties: {
        city: { type: "string", description: 'Place name, e.g. "London" or "Austin, Texas"' },
      },
      required: ["city"],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
]

const getWeather = async (city) => {
  const geoRes = await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`,
  )
  const geo = await geoRes.json()
  const place = geo?.results?.[0]
  if (!place) throw new Error(`no such place: ${city}`)
  const wx = await (
    await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
        "&current=temperature_2m,wind_speed_10m,weather_code",
    )
  ).json()
  const c = wx.current
  return {
    place: [place.name, place.admin1, place.country].filter(Boolean).join(", "),
    temperature_c: c.temperature_2m,
    wind_kph: c.wind_speed_10m,
    condition: WMO[c.weather_code] ?? `code ${c.weather_code}`,
    observed_at: c.time,
    source: "open-meteo.com",
  }
}

const rpc = async (body) => {
  const id = body?.id ?? null
  const ok = (result) => ({ jsonrpc: "2.0", id, result })
  if (body?.method === "initialize")
    return ok({
      protocolVersion: "2025-11-25",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "weather", version: "1.0.0" },
    })
  if (body?.method === "tools/list") return ok({ tools: TOOLS })
  if (body?.method === "tools/call") {
    const { name, arguments: args } = body.params ?? {}
    if (name !== "get_current_weather")
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `no such tool: ${name}` } }
    try {
      const data = await getWeather(String(args?.city ?? "London"))
      return ok({
        content: [{ type: "text", text: JSON.stringify(data) }],
        structuredContent: data,
      })
    } catch (e) {
      return { jsonrpc: "2.0", id, error: { code: -32000, message: String(e.message ?? e) } }
    }
  }
  if (typeof body?.method === "string" && body.method.startsWith("notifications/")) return null // notifications get 202, no body
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method: ${body?.method}` } }
}

export default {
  async fetch(req) {
    if (req.method !== "POST") return new Response("method not allowed", { status: 405 })
    const out = await rpc(await req.json().catch(() => ({})))
    if (!out) return new Response(null, { status: 202 })
    return new Response(JSON.stringify(out), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  },
}

// --- Node bootstrap (ignored when deployed as a Worker) ---------------------------------------
if (globalThis.process?.argv?.[1]?.endsWith("weather-mcp.mjs")) {
  const { createServer } = await import("node:http")
  const port = Number(process.argv[2] ?? 8940)
  createServer((req, res) => {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", async () => {
      if (req.method !== "POST") {
        res.writeHead(405)
        return res.end()
      }
      let body = {}
      try {
        body = JSON.parse(raw || "{}")
      } catch {}
      const out = await rpc(body)
      if (!out) {
        res.writeHead(202)
        return res.end()
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify(out))
    })
  }).listen(port, () => process.stdout.write(`weather MCP on http://localhost:${port}/mcp\n`))
}
