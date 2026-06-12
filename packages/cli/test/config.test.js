import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  CONFIG_FILE,
  TEMPLATES,
  defaultConfig,
  loadConfig,
  resolvePublish,
  scaffold,
  scaffoldFiles,
  writeId,
} from "../src/config.js"

const dirs = []
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "dock-cli-"))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe("scaffold", () => {
  it("md template writes dock.json + index.md + AGENTS.md", () => {
    const d = tmp()
    const { created } = scaffold(d, "Report", "md")
    expect(created.sort()).toEqual(["AGENTS.md", "dock.json", "index.md"])
    const cfg = JSON.parse(readFileSync(join(d, CONFIG_FILE), "utf8"))
    expect(cfg).toMatchObject({ title: "Report", entry: "index.md", id: null, visibility: "link" })
  })

  it("html template uses index.html as the entry", () => {
    const d = tmp()
    scaffold(d, "Page", "html")
    expect(JSON.parse(readFileSync(join(d, CONFIG_FILE), "utf8")).entry).toBe("index.html")
    expect(readFileSync(join(d, "index.html"), "utf8")).toContain("<title>Page</title>")
  })

  it("slides template scaffolds a self-contained deck with a nav layer", () => {
    const d = tmp()
    const { created } = scaffold(d, "Talk", "slides")
    expect(created).toContain("slides.html")
    const html = readFileSync(join(d, "slides.html"), "utf8")
    expect(JSON.parse(readFileSync(join(d, CONFIG_FILE), "utf8")).entry).toBe("slides.html")
    expect(html).toContain('class="slide')
    expect(html).toMatch(/ArrowRight|ArrowLeft/) // keyboard navigation present
  })

  it("never clobbers existing files", () => {
    const d = tmp()
    writeFileSync(join(d, CONFIG_FILE), '{"title":"mine","id":"keep"}')
    const { created, skipped } = scaffold(d, "X", "md")
    expect(skipped).toContain(CONFIG_FILE)
    expect(created).not.toContain(CONFIG_FILE)
    expect(JSON.parse(readFileSync(join(d, CONFIG_FILE), "utf8")).id).toBe("keep")
  })

  it("exposes the three templates", () => {
    expect(TEMPLATES).toEqual(["md", "html", "slides"])
    expect(Object.keys(scaffoldFiles("T", "slides"))).toContain("slides.html")
  })
})

describe("loadConfig", () => {
  it("returns null when no dock.json", () => {
    expect(loadConfig(tmp())).toBeNull()
  })
  it("parses dock.json", () => {
    const d = tmp()
    writeFileSync(join(d, CONFIG_FILE), JSON.stringify(defaultConfig("Y")))
    expect(loadConfig(d)).toMatchObject({ title: "Y", entry: "index.md" })
  })
  it("throws a clear error on malformed JSON", () => {
    const d = tmp()
    writeFileSync(join(d, CONFIG_FILE), "{ not json")
    expect(() => loadConfig(d)).toThrow(/not valid JSON/)
  })
})

describe("resolvePublish", () => {
  it("flags win over config win over defaults", () => {
    const cfg = { id: "cfg", title: "cfgTitle", entry: "doc.md", visibility: "org", spa: true, server: "http://cfg" }
    const r = resolvePublish({ title: "flagTitle", server: "http://flag" }, cfg)
    expect(r.title).toBe("flagTitle") // flag wins
    expect(r.id).toBe("cfg") // from config
    expect(r.target).toBe("doc.md") // config entry
    expect(r.visibility).toBe("org")
    expect(r.spa).toBe(true)
    expect(r.server).toBe("http://flag")
  })
  it("falls back to defaults with no config", () => {
    const r = resolvePublish({ target: "x.md" }, null)
    expect(r.id).toBeNull()
    expect(r.target).toBe("x.md")
    expect(r.server).toBe("http://localhost:8080")
  })
  it("--spa flag string coerces to boolean", () => {
    expect(resolvePublish({ spa: "true" }, null).spa).toBe(true)
    expect(resolvePublish({}, { spa: false }).spa).toBe(false)
  })
})

describe("writeId", () => {
  it("writes the assigned id, preserving other keys", () => {
    const d = tmp()
    scaffold(d, "Doc", "md")
    writeId(d, "ab12cd34")
    const cfg = JSON.parse(readFileSync(join(d, CONFIG_FILE), "utf8"))
    expect(cfg.id).toBe("ab12cd34")
    expect(cfg.title).toBe("Doc") // untouched
    expect(cfg.entry).toBe("index.md")
  })
  it("creates a config if missing", () => {
    const d = tmp()
    writeId(d, "zz99")
    expect(loadConfig(d).id).toBe("zz99")
  })
})
