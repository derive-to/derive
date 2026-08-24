#!/usr/bin/env node
// Favicons cross two renderers with different jobs: crawlers read the raw dark
// defaults for light search surfaces, while browsers may swap to a white glyph
// for dark chrome. Pin both the vector contract and the PNG pixels so the exact
// white-on-white fallback that reached Google cannot silently return.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { inflateSync } from "node:zlib"

const ROOT = process.cwd()
const BRAND = join(ROOT, "apps/web/public/brand")
const failures = []
const fail = (message) => failures.push(message)

for (const [name, color] of [
  ["favicon.svg", "#030712"],
  ["favicon-dark.svg", "#F4F5F8"],
]) {
  const source = readFileSync(join(BRAND, name), "utf8")
  const viewBox = source
    .match(/viewBox="([^"]+)"/)?.[1]
    ?.split(/\s+/)
    .map(Number)
  if (viewBox?.length !== 4 || viewBox[2] !== viewBox[3])
    fail(`${name}: favicon viewBox must be square`)
  if (!source.includes(color)) fail(`${name}: missing expected glyph color ${color}`)
  if (/prefers-color-scheme|<style\b/.test(source))
    fail(`${name}: theme selection belongs in the browser, not the crawler-visible asset`)
}

const paeth = (left, up, upperLeft) => {
  const estimate = left + up - upperLeft
  const leftDistance = Math.abs(estimate - left)
  const upDistance = Math.abs(estimate - up)
  const upperLeftDistance = Math.abs(estimate - upperLeft)
  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) return left
  return upDistance <= upperLeftDistance ? up : upperLeft
}

const visibleLuma = (name) => {
  const png = readFileSync(join(BRAND, name))
  if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    fail(`${name}: not a PNG`)
    return null
  }

  let width
  let height
  let bitDepth
  let colorType
  let interlace
  const compressed = []
  for (let offset = 8; offset + 12 <= png.length; ) {
    const length = png.readUInt32BE(offset)
    const type = png.toString("ascii", offset + 4, offset + 8)
    const start = offset + 8
    if (type === "IHDR") {
      width = png.readUInt32BE(start)
      height = png.readUInt32BE(start + 4)
      bitDepth = png[start + 8]
      colorType = png[start + 9]
      interlace = png[start + 12]
    } else if (type === "IDAT") compressed.push(png.subarray(start, start + length))
    offset = start + length + 4
    if (type === "IEND") break
  }
  if (width !== 512 || height !== 512) fail(`${name}: expected 512x512, got ${width}x${height}`)
  if (bitDepth !== 8 || colorType !== 6 || interlace !== 0) {
    fail(`${name}: expected non-interlaced 8-bit RGBA PNG`)
    return null
  }

  const bytes = inflateSync(Buffer.concat(compressed))
  const stride = width * 4
  let sourceOffset = 0
  let previous = Buffer.alloc(stride)
  let total = 0
  let visible = 0
  for (let y = 0; y < height; y += 1) {
    const filter = bytes[sourceOffset]
    sourceOffset += 1
    const row = Buffer.alloc(stride)
    for (let x = 0; x < stride; x += 1) {
      const raw = bytes[sourceOffset + x]
      const left = x >= 4 ? row[x - 4] : 0
      const up = previous[x]
      const upperLeft = x >= 4 ? previous[x - 4] : 0
      const predictor =
        filter === 0
          ? 0
          : filter === 1
            ? left
            : filter === 2
              ? up
              : filter === 3
                ? Math.floor((left + up) / 2)
                : filter === 4
                  ? paeth(left, up, upperLeft)
                  : null
      if (predictor === null) {
        fail(`${name}: unsupported PNG row filter ${filter}`)
        return null
      }
      row[x] = (raw + predictor) & 0xff
    }
    sourceOffset += stride
    for (let x = 0; x < stride; x += 4) {
      if (row[x + 3] === 0) continue
      total += (row[x] + row[x + 1] + row[x + 2]) / 3
      visible += 1
    }
    previous = row
  }
  return visible ? total / visible : null
}

const lightSurfaceLuma = visibleLuma("favicon.png")
const darkSurfaceLuma = visibleLuma("favicon-dark.png")
if (lightSurfaceLuma === null || lightSurfaceLuma >= 64)
  fail(`favicon.png: default glyph must be dark (mean luma ${lightSurfaceLuma})`)
if (darkSurfaceLuma === null || darkSurfaceLuma <= 192)
  fail(`favicon-dark.png: dark-chrome glyph must be light (mean luma ${darkSurfaceLuma})`)

const rootRoute = readFileSync(join(ROOT, "apps/web/src/routes/__root.tsx"), "utf8")
for (const contract of [
  'href: "/brand/favicon.png"',
  '"data-dark-href": "/brand/favicon-dark.png"',
  'href: "/brand/favicon.svg"',
  '"data-dark-href": "/brand/favicon-dark.svg"',
  "FAVICON_BOOT",
])
  if (!rootRoute.includes(contract)) fail(`app root: missing ${contract}`)

if (failures.length) {
  console.error(`favicons: ${failures.length} problem(s)`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log("favicons: ok — square dark crawler defaults and light dark-chrome variants")
