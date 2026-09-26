import { decodeHTML } from "entities"
import { describe, expect, it } from "vitest"
// The synthetic Markdown article the editing fuzz's Markdown mode drives.
import ARTICLE from "../../../apps/web/e2e/fuzz/docs/article.md?raw"
import { attrValues, tags } from "../src/html-tags"
import {
  applyMarkdownOps,
  markdownSourceMap,
  renderMarkdownForEditor,
} from "../src/markdown-source"
import { escapeHtml, renderMarkdown } from "../src/md"
import {
  applySourceOps,
  SourceConflictError,
  type SourceOp,
  type SourceToken,
  sourceMap,
  sourceSha,
  stampSourceIds,
} from "../src/source-edit"
import { sourceElements } from "../src/structural-edit"
import { setOpeningTagStyle } from "../src/style-attribute"
// The 44-slide deck the editing fuzz harness drives (placeholder copy, real markup).
import DECK from "./fixtures/decks/structural-deck-44.html?raw"

const unstamp = (html: string): string =>
  html
    .replace(/ data-derive-src="\d+"/g, "")
    .replace(/ data-derive-src-version="\d+" data-derive-src-sha="[0-9a-f]+"/, "")

describe("stampSourceIds", () => {
  const doc = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>a <b> title</title>
<style>p > b { color: red }</style><script>const s = "<div>"</script></head>
<body class="x">
<!-- <p>commented</p> -->
<main title="a > b"><p>One<br>two <img src="x.png" alt=">"></p>
<textarea><p>not a tag</p></textarea>
<template><div>template body</div></template>
<script>document.write("<section>")</script>
<svg viewBox="0 0 1 1"><path d="M0 0"/></svg></main>
</body></html>`

  it("changes nothing but the inserted attributes, and numbers every start tag", async () => {
    const sha = await sourceSha(doc)
    const out = stampSourceIds(doc, { version: 7, sha })
    expect(unstamp(out)).toBe(doc)
    expect(out).toContain(
      `<html data-derive-src-version="7" data-derive-src-sha="${sha}" lang="en">`,
    )
    // N is the index among ALL start tags (head included); only body elements carry it.
    const names = tags(doc).filter((t) => !t.closing)
    const stamped = [...out.matchAll(/<([a-z]+) data-derive-src="(\d+)"/g)].map(
      (m) => [m[1], Number(m[2])] as const,
    )
    for (const [name, n] of stamped) expect(names[n]?.name).toBe(name)
    expect(stamped.map(([name]) => name)).toEqual([
      "body",
      "main",
      "p",
      "br",
      "img",
      "textarea",
      "template",
      "script",
      "svg",
      "path",
    ])
    // Raw text, RCDATA, comments and template contents are never touched.
    expect(out).toContain('<textarea data-derive-src="11"><p>not a tag</p></textarea>')
    expect(out).toContain('<template data-derive-src="12"><div>template body</div></template>')
    expect(out).toContain("<!-- <p>commented</p> -->")
    expect(out).toContain('<script>const s = "<div>"</script>')
  })

  it("gives a fragment a root carrying the base identity", () => {
    const out = stampSourceIds("Hi <b>there</b><p>x</p>", { version: 2, sha: "ab" })
    expect(out).toBe(
      'Hi <html data-derive-src-version="2" data-derive-src-sha="ab"><b data-derive-src="0">there</b><p data-derive-src="1">x</p>',
    )
  })

  it("stamps the 44-slide deck byte-identically and agrees with the source map", async () => {
    const sha = await sourceSha(DECK)
    const out = stampSourceIds(DECK, { version: 3, sha })
    expect(unstamp(out)).toBe(DECK)
    const map = await sourceMap(DECK)
    expect(map.sha).toBe(sha)
    const els = sourceElements(DECK)
    expect(map.hashes).toHaveLength(els.length)
    const stamped = new Set([...out.matchAll(/data-derive-src="(\d+)"/g)].map((m) => Number(m[1])))
    for (let n = 0; n < els.length; n++)
      expect(map.hashes[n]).toMatch(stamped.has(n) ? /^[0-9a-f]{16}$/ : /^$/)
    expect(stamped.size).toBeGreaterThan(1000)
  })
})

// ── A model of the fixture the random sessions edit ──────────────────────────────────

interface Node {
  n: number
  name: string
  start: number
  openEnd: number
  closeStart: number
  end: number
  kids: number[]
  parent: number | null
}

const modelOf = (html: string) => {
  const els = sourceElements(html)
  const byStart = new Map(els.map((e, n) => [e.tag.start, n]))
  const nodes: Node[] = els.map((e, n) => ({
    n,
    name: e.tag.name,
    start: e.tag.start,
    openEnd: e.tag.end,
    closeStart: e.closeStart,
    end: e.end,
    kids: [],
    parent: e.parentStart === null ? null : (byStart.get(e.parentStart) ?? null),
  }))
  for (const node of nodes) if (node.parent !== null) nodes[node.parent]?.kids.push(node.n)
  return nodes
}

const nodes = modelOf(DECK)
const node = (n: number): Node => nodes[n] as Node
const body = nodes.find((n) => n.name === "body") as Node
const stage = nodes.find((n) => DECK.slice(n.start, n.openEnd).includes('id="stage"')) as Node
const slideOf = (n: Node): number | null => {
  let cur: Node | undefined = n
  while (cur && cur.parent !== stage.n) cur = cur.parent === null ? undefined : node(cur.parent)
  return cur ? cur.n : null
}
const contains = (a: Node, b: Node): boolean => a.start <= b.start && b.end <= a.end
const ancestors = (n: Node): Node[] =>
  n.parent === null ? [] : [node(n.parent), ...ancestors(node(n.parent))]
const OPAQUE = new Set(["script", "style", "textarea", "title", "template", "img", "br"])
const editable = nodes.filter(
  (n) => contains(body, n) && n !== body && !OPAQUE.has(n.name) && n.closeStart >= 0,
)

let hashes: string[] = []
const keep = (n: number, children?: SourceToken[]): SourceToken =>
  children
    ? { keep: n, hash: hashes[n] as string, children }
    : { keep: n, hash: hashes[n] as string }
/** A node's current children as the editor would serialize them unchanged. */
const tokensOf = (n: Node): SourceToken[] => {
  const out: SourceToken[] = []
  let cursor = n.openEnd
  // Text runs decoded as the DOM holds them; comments as their Comment node's data.
  const gap = (to: number) => {
    for (const [i, part] of DECK.slice(cursor, to)
      .split(/<!--([\s\S]*?)-->/)
      .entries()) {
      if (i % 2) out.push({ comment: part })
      else if (part) out.push({ text: decodeHTML(part) })
    }
  }
  for (const k of n.kids) {
    gap(node(k).start)
    out.push(keep(k))
    cursor = node(k).end
  }
  gap(n.closeStart)
  return out
}

const escText = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
/** Independent oracle: what the saved source must be, built from the model's offsets. */
const renderTokens = (list: SourceToken[]): string =>
  list
    .map((t) => {
      if ("text" in t) return escText(t.text)
      if ("comment" in t) return `<!--${t.comment}-->`
      if ("tag" in t) {
        if (t.tag === "br") return "<br>"
        const open = t.tag === "a" ? `<a href="${escapeHtml(t.href ?? "")}">` : `<${t.tag}>`
        return `${open}${renderTokens(t.children ?? [])}</${t.tag}>`
      }
      const k = node(t.keep)
      return t.children
        ? DECK.slice(k.start, k.openEnd) +
            renderTokens(t.children) +
            DECK.slice(k.closeStart, k.end)
        : DECK.slice(k.start, k.end)
    })
    .join("")
interface Segment {
  start: number
  end: number
  text: string
}
const splice = (html: string, segments: Segment[]): string => {
  let out = ""
  let cursor = 0
  for (const s of [...segments].sort((a, b) => a.start - b.start)) {
    out += html.slice(cursor, s.start) + s.text
    cursor = s.end
  }
  return out + html.slice(cursor)
}
const segmentsOf = (ops: SourceOp[]): Segment[] =>
  ops.map((op) => {
    const n = node(op.src)
    return op.op === "content"
      ? { start: n.openEnd, end: n.closeStart, text: renderTokens(op.children) }
      : {
          start: n.start,
          end: n.openEnd,
          text: setOpeningTagStyle(
            DECK.slice(n.start, n.openEnd),
            op.style ? escapeHtml(op.style).replaceAll("'", "&#39;") : null,
          ),
        }
  })

// Identity attributes a duplicate legitimately rewrites, and the live-slide class it drops.
const normalizeIdentity = (html: string): string =>
  html
    .replace(/\b(id|for|aria-[a-z]+|data-derive-(?:slide|region|node|owner))="[^"]*"/g, '$1="*"')
    .replace(
      /class="([^"]*)"/g,
      (_m, v: string) =>
        `class="${v
          .split(/\s+/)
          .filter((c) => !["on", "active"].includes(c))
          .join(" ")}"`,
    )
const unique = (html: string, attr: string): boolean => {
  const values = tags(html).flatMap((t) => (t.closing ? [] : attrValues(t.attrs, attr)))
  return new Set(values).size === values.length
}

const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const WORDS = [
  "Rollout",
  "a & b",
  "5 > 3 < 4",
  "“quoted”",
  'say "hi"',
  "it's",
  "naïve 🎉",
  "\n",
  "  ",
]

/** One random editing session: 1–10 non-nested ops mixing every gesture the editor has. */
const session = (r: () => number) => {
  const pick = <T>(list: T[]): T => list[Math.floor(r() * list.length)] as T
  const ops: SourceOp[] = []
  const targets: Node[] = []
  const styled: Node[] = []
  const kept = new Set<number>()
  let copies = false
  const free = (n: Node) =>
    !targets.some((t) => contains(t, n) || contains(n, t)) &&
    !styled.some((s) => contains(n, s) && s !== n)
  const content = (n: Node, children: SourceToken[]) => {
    targets.push(n)
    ops.push({ op: "content", src: n.n, hash: hashes[n.n] as string, children })
  }
  const mutateText = (list: SourceToken[]): SourceToken[] => {
    const i = Math.floor(r() * (list.length + 1))
    const t = list[i]
    if (t && "text" in t && r() < 0.6) {
      const at = Math.floor(r() * (t.text.length + 1))
      const cut = r() < 0.3 ? Math.floor(r() * 5) : 0
      return list.with(i, { text: t.text.slice(0, at) + pick(WORDS) + t.text.slice(at + cut) })
    }
    return [...list.slice(0, i), { text: pick(WORDS) }, ...list.slice(i)]
  }
  if (r() < 0.12) {
    // Whole-deck rearrange on the slide container: reorder, duplicate, delete slides.
    let list = tokensOf(stage)
    for (let k = 0; k < 1 + r() * 4; k++) {
      const slides = list.flatMap((t, i) => ("keep" in t ? [i] : []))
      const i = pick(slides)
      const t = list[i] as SourceToken
      const move = r()
      if (move < 0.4) {
        list = list.toSpliced(i, 1)
        list.splice(pick(list.flatMap((u, j) => ("keep" in u ? [j] : []))), 0, t)
      } else if (move < 0.7 && slides.length > 2) list = list.toSpliced(i, 1)
      else {
        list = list.toSpliced(i, 0, t)
        copies = true
      }
    }
    content(stage, list)
    return { ops, copies, targets, kept }
  }
  const edits = 1 + Math.floor(r() * 10)
  for (let e = 0; e < edits * 4 && ops.length < edits; e++) {
    const kind = pick([
      "text",
      "text",
      "reorder",
      "delete",
      "duplicate",
      "move",
      "format",
      "nested",
      "attrs",
    ])
    const n = pick(editable)
    if (kind === "attrs") {
      if (targets.some((t) => contains(t, n) && t !== n) || kept.has(n.n) || styled.includes(n))
        continue
      styled.push(n)
      ops.push({
        op: "attrs",
        src: n.n,
        hash: hashes[n.n] as string,
        style: pick(["width: 320px; height: auto", null, 'font-family: "A&B"', "max-width: 50%"]),
      })
      continue
    }
    if (!free(n) || slideOf(n) === null || n === stage) continue
    let list = tokensOf(n)
    const keeps = list.flatMap((t, i) => ("keep" in t ? [i] : []))
    if (kind === "text") content(n, mutateText(list))
    else if (kind === "format") {
      const inLink = [n, ...ancestors(n)].some((a) => a.name === "a")
      const tag = pick(
        inLink ? ["b", "i", "strong", "em", "br"] : ["b", "i", "strong", "em", "a", "br"],
      )
      const token: SourceToken =
        tag === "br"
          ? { tag: "br" }
          : tag === "a"
            ? { tag: "a", href: "https://example.com/?a=1&b=2", children: [{ text: pick(WORDS) }] }
            : { tag: tag as "b", children: [{ text: pick(WORDS) }] }
      content(n, list.toSpliced(Math.floor(r() * (list.length + 1)), 0, token))
    } else if (kind === "nested") {
      const withText = n.kids.filter(
        (k) => !OPAQUE.has(node(k).name) && tokensOf(node(k)).some((t) => "text" in t),
      )
      if (!withText.length) continue
      const k = pick(withText)
      kept.add(k)
      content(
        n,
        list.map((t) => ("keep" in t && t.keep === k ? keep(k, mutateText(tokensOf(node(k)))) : t)),
      )
    } else if (keeps.length === 0) continue
    else if (kind === "reorder" && keeps.length > 1) {
      const i = pick(keeps)
      const t = list[i] as SourceToken
      list = list.toSpliced(i, 1)
      content(n, list.toSpliced(pick(list.flatMap((u, j) => ("keep" in u ? [j] : []))), 0, t))
    } else if (kind === "delete") content(n, list.toSpliced(pick(keeps), 1))
    else if (kind === "duplicate") {
      const i = pick(keeps)
      copies = true
      content(n, list.toSpliced(i, 0, list[i] as SourceToken))
    } else if (kind === "move") {
      // Cut a block out of one slide and paste it into another: two ops, one save.
      const i = pick(keeps)
      const moved = list[i] as SourceToken & { keep: number }
      const into = editable.filter(
        (b) =>
          free(b) &&
          !contains(b, n) &&
          !contains(n, b) &&
          slideOf(b) !== slideOf(n) &&
          slideOf(b) !== null,
      )
      if (!into.length || styled.some((s) => contains(node(moved.keep), s))) continue
      const b = pick(into)
      const target = tokensOf(b)
      content(n, list.toSpliced(i, 1))
      content(b, target.toSpliced(Math.floor(r() * (target.length + 1)), 0, moved))
      kept.add(moved.keep)
    }
  }
  return { ops, copies, targets, kept }
}

describe("applySourceOps", () => {
  it("round-trips 400 random editing sessions over the 44-slide deck", async () => {
    hashes = (await sourceMap(DECK)).hashes
    expect(sourceElements(DECK).every((e) => e.end >= 0)).toBe(true)
    const r = rng(0x5eed)
    let conflicts = 0
    for (let trial = 0; trial < 400; trial++) {
      const { ops, copies, targets, kept } = session(r)
      if (!ops.length) continue
      const expected = splice(DECK, segmentsOf(ops))
      const label = `trial ${trial}: ${JSON.stringify(ops).slice(0, 400)}`
      if (expected === DECK) {
        await expect(applySourceOps(DECK, ops), label).rejects.toThrow(/nothing to save/)
        continue
      }
      const { html } = await applySourceOps(DECK, ops)
      // Every byte outside the edited elements, and every kept element, is the stored bytes;
      // a duplicate differs only in the identities it had to mint.
      if (copies) {
        expect(normalizeIdentity(html), label).toBe(normalizeIdentity(expected))
        for (const attr of ["id", "data-derive-slide", "data-derive-node", "data-derive-region"])
          expect(unique(html, attr), `${label} ${attr}`).toBe(true)
      } else expect(html, label).toBe(expected)
      // The saved source re-parses to closed, properly nested elements with the expected shape.
      const parsed = sourceElements(html)
      expect(
        parsed.every((e) => e.end >= 0),
        label,
      ).toBe(true)
      expect(
        parsed.map((e) => e.tag.name),
        label,
      ).toEqual(sourceElements(expected).map((e) => e.tag.name))
      expect(html).not.toContain("data-derive-src")
      // Comments inside an edited element survive byte-exactly (the deck's slide markers
      // live inside the slide container a whole-deck rearrange rewrites).
      for (const marker of ["<!-- derive:slides:start -->", "<!-- derive:slides:end -->"])
        expect(html.split(marker).length, `${label} ${marker}`).toBe(2)

      // A save based on an older version still lands when only unrelated elements changed…
      const referenced = [...targets, ...[...kept].map(node), ...ops.map((o) => node(o.src))]
      const leaf = nodes.find(
        (n) =>
          contains(body, n) &&
          n.kids.length === 0 &&
          n.closeStart > n.openEnd &&
          !OPAQUE.has(n.name) &&
          (trial * 7919 + n.n) % 13 === 0 &&
          !referenced.some((x) => contains(x, n) || contains(n, x)) &&
          !ops.some((o) => o.op === "content" && JSON.stringify(o).includes(`"keep":${n.n},`)),
      )
      if (!leaf) continue
      const edit = { start: leaf.openEnd, end: leaf.closeStart, text: "Changed by someone else" }
      const head = splice(DECK, [edit])
      const onHead = await applySourceOps(head, ops)
      const expectedHead = splice(DECK, [...segmentsOf(ops), edit])
      if (copies)
        expect(normalizeIdentity(onHead.html), label).toBe(normalizeIdentity(expectedHead))
      else expect(onHead.html, label).toBe(expectedHead)
      // …and is refused, naming the element, when one it references changed.
      const touched = referenced[0]
      if (!touched || touched.closeStart <= touched.openEnd) continue
      const clash = splice(DECK, [{ start: touched.openEnd, end: touched.openEnd, text: "x" }])
      const error = await applySourceOps(clash, ops).catch((e: unknown) => e)
      expect(error, label).toBeInstanceOf(SourceConflictError)
      expect((error as SourceConflictError).conflicts, label).toContain(touched.n)
      conflicts++
    }
    expect(conflicts).toBeGreaterThan(50)
  }, 60_000)

  const small = `<!doctype html><html><body><section class="slide" data-derive-slide="1"><h2 id="t">Title</h2><p>One <b>bold</b> two</p></section><section class="slide on" data-derive-slide="2" data-derive-region="slide-2"><div data-derive-node="s2-card" aria-labelledby="c2"><h3 id="c2">Card</h3></div><img src="a.png"></section></body></html>`
  const setup = async () => {
    const map = await sourceMap(small)
    const els = sourceElements(small)
    const at = (name: string, i = 0) =>
      els.map((e, n) => ({ e, n })).filter(({ e }) => e.tag.name === name)[i]?.n as number
    const k = (n: number, children?: SourceToken[]): SourceToken =>
      children
        ? { keep: n, hash: map.hashes[n] as string, children }
        : { keep: n, hash: map.hashes[n] as string }
    const op = (n: number, children: SourceToken[]): SourceOp => ({
      op: "content",
      src: n,
      hash: map.hashes[n] as string,
      children,
    })
    return { map, at, k, op }
  }

  it("escapes text, emits only allowlisted markup, and refuses everything else", async () => {
    const { at, k, op } = await setup()
    const p = at("p")
    const { html, changes } = await applySourceOps(small, [
      op(p, [
        { text: '<b data-derive-src="9">x</b> & ' },
        k(at("b")),
        { tag: "a", href: 'https://e.com/?a=1&b="2"', children: [{ text: "link" }] },
        { tag: "br" },
      ]),
    ])
    expect(html).toContain(
      '<p>&lt;b data-derive-src="9"&gt;x&lt;/b&gt; &amp; <b>bold</b><a href="https://e.com/?a=1&amp;b=&quot;2&quot;">link</a><br></p>',
    )
    expect(changes).toEqual([
      { before: "One <b>bold</b> two", after: expect.stringContaining("&lt;b") },
    ])
    await expect(
      applySourceOps(small, [op(p, [{ tag: "a", href: "javascript:alert(1)", children: [] }])]),
    ).rejects.toThrow(/http\(s\) or mailto/)
    await expect(applySourceOps(small, [op(p, [{ tag: "span" } as never])])).rejects.toThrow(
      /isn't a token/,
    )
    await expect(applySourceOps(small, [op(p, [{ tag: "br", children: [] }])])).rejects.toThrow(
      /br has no children/,
    )
    await expect(applySourceOps(small, [op(at("img"), [])])).rejects.toThrow(/<img>/)
    // Comments round-trip from their DOM data; anything that could end one early is refused.
    // `<!-- a -- b -->` parses to " a -- b " and comes back byte-exact; the legacy
    // `<!-- old --!>` parses to " old " and comes back with the standard terminator, and
    // `<!-- note --->` parses to " note -" and comes back byte-exact.
    const noted = await applySourceOps(small, [
      op(p, [
        { comment: " author note <b> " },
        { comment: " a -- b " },
        { comment: " old " },
        { comment: " note -" },
        { text: "One " },
        k(at("b")),
      ]),
    ])
    expect(noted.html).toContain(
      "<p><!-- author note <b> --><!-- a -- b --><!-- old --><!-- note --->One <b>bold</b></p>",
    )
    for (const comment of ["a --> b", "a --!> b", "a <!-- b", ">x", "->x", "x <!-"])
      await expect(applySourceOps(small, [op(p, [{ comment }])]), comment).rejects.toThrow(
        /a comment can't contain/,
      )
  })

  it("refuses nested ops and cycles, naming the slide", async () => {
    const { at, k, op } = await setup()
    await expect(
      applySourceOps(small, [op(at("section"), [k(at("h2"))]), op(at("p"), [{ text: "x" }])]),
    ).rejects.toThrow(/slide 1 \(element \d+\) is inside slide 1 \(element \d+\)/)
    await expect(applySourceOps(small, [op(at("p"), [k(at("section"))])])).rejects.toThrow(
      /slide 1 \(element \d+\) can't be kept inside slide 1/,
    )
    await expect(
      applySourceOps(small, [op(at("section", 1), [k(at("div"), [k(at("div"))])])]),
    ).rejects.toThrow(/can't be kept inside/)
  })

  it("duplicates with fresh identities, deletes by omission, and resizes kept elements", async () => {
    const { map, at, k, op } = await setup()
    const [s1, s2] = [at("section"), at("section", 1)]
    const { html } = await applySourceOps(small, [
      op(at("body"), [k(s2), k(s2), k(s1)]),
      { op: "attrs", src: at("img"), hash: map.hashes[at("img")] as string, style: "width: 50px" },
    ])
    // Slide 2 moved first, its copy is a new inactive slide with new ids, slide 1 follows.
    expect(html).toBe(
      '<!doctype html><html><body><section class="slide on" data-derive-slide="2" data-derive-region="slide-2"><div data-derive-node="s2-card" aria-labelledby="c2"><h3 id="c2">Card</h3></div><img src="a.png" style="width: 50px"></section>' +
        '<section class="slide" data-derive-slide="3" data-derive-region="slide-3"><div data-derive-node="s3-card" aria-labelledby="c2--derive-copy-3"><h3 id="c2--derive-copy-3">Card</h3></div><img src="a.png" style="width: 50px"></section>' +
        `${small.slice(small.indexOf('<section class="slide" data-derive-slide="1"'), small.indexOf('<section class="slide on"'))}</body></html>`,
    )
    // Omitting an element deletes it; the card moves out of slide 2 into slide 1.
    const moved = await applySourceOps(small, [
      op(at("section"), [k(at("h2")), k(at("div"))]),
      op(at("section", 1), [k(at("img"))]),
    ])
    expect(moved.html).toContain(
      '<section class="slide" data-derive-slide="1"><h2 id="t">Title</h2><div data-derive-node="s2-card" aria-labelledby="c2"><h3 id="c2">Card</h3></div></section><section class="slide on" data-derive-slide="2" data-derive-region="slide-2"><img src="a.png"></section>',
    )
  })

  it("sets structural layout with a text edit in one atomic save, by the structural contract", async () => {
    const { map, at, op } = await setup()
    const card = at("div")
    const layout = (attrs: Record<string, string | null>, style: string | null): SourceOp => ({
      op: "attrs",
      src: card,
      hash: map.hashes[card] as string,
      style,
      attrs,
    })
    const text = op(at("p"), [{ text: "Edited" }])
    const { html } = await applySourceOps(small, [
      text,
      layout(
        { "data-derive-width": "60", "data-derive-align": "center" },
        "--derive-structural-width: 60%; --derive-structural-align: center",
      ),
    ])
    expect(html).toContain("<p>Edited</p>")
    expect(html).toContain(
      '<div data-derive-node="s2-card" aria-labelledby="c2" style="--derive-structural-width: 60%; --derive-structural-align: center" data-derive-width="60" data-derive-align="center">',
    )
    // Removing a value removes the attribute; the rest of the tag is untouched.
    const moved = card - 1 // the edit dropped the <b> before it
    const { html: reset } = await applySourceOps(html, [
      {
        op: "attrs",
        src: moved,
        hash: (await sourceMap(html)).hashes[moved] as string,
        style: null,
        attrs: { "data-derive-width": null, "data-derive-align": null },
      },
    ])
    expect(reset).toBe(small.replace("<p>One <b>bold</b> two</p>", "<p>Edited</p>"))
    // Anything the contract refuses fails the whole save, text edit included.
    for (const [bad, message] of [
      [layout({ "data-derive-width": "60" }, null), /must pair data-derive-width/],
      [layout({ "data-derive-width": "3" }, "--derive-structural-width: 3%"), /whole percentage/],
      [layout({ "data-derive-size": "huge" }, null), /unsupported size/],
      [layout({ "data-derive-size": 'full" onclick="x' }, null), /invalid data-derive-size/],
      [layout({ "data-derive-node": "x" }, null), /can't set data-derive-node/],
      [layout({ onclick: "x" }, null), /can't set onclick/],
    ] as const)
      await expect(applySourceOps(small, [text, bad])).rejects.toThrow(message)
  })

  it("is atomic: one stale element refuses the whole save", async () => {
    const { at, op, k } = await setup()
    const head = small.replace("Card", "Card!")
    const error = await applySourceOps(head, [
      op(at("p"), [{ text: "fine" }]),
      op(at("section", 1), [k(at("img"))]),
    ]).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SourceConflictError)
    expect((error as SourceConflictError).conflicts).toEqual([at("section", 1)])
    expect((error as Error).message).toMatch(/slide 2 \(element \d+\)/)
  })
})

// ── Markdown ─────────────────────────────────────────────────────────────────────────

/** The editor's view of a Markdown page as a tree: what the frame walks to build ops. */
interface MdEl {
  tag: string
  src: number | null
  ro: boolean
  kids: (string | MdEl)[]
  parent: MdEl | null
}
const VOID = new Set(["br", "img", "hr", "input"])
const BLOCKS = /^(?:p|h[1-6]|li|ul|ol|blockquote|pre|table|thead|tbody|tr|td|th|hr|main)$/
const parseStamped = (page: string): MdEl => {
  const html = page.slice(page.indexOf("<main"), page.indexOf("</main>") + 7)
  const root: MdEl = { tag: "#root", src: null, ro: false, kids: [], parent: null }
  let at = root
  for (const m of html.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*)>|[^<]+/g)) {
    const [whole, close, tag, attrs] = m
    if (!tag) {
      at.kids.push(decodeHTML(whole))
      continue
    }
    if (close) {
      at = at.parent ?? root
      continue
    }
    const el: MdEl = {
      tag,
      src: /data-derive-src="(\d+)"/.test(attrs ?? "")
        ? Number(/data-derive-src="(\d+)"/.exec(attrs ?? "")?.[1])
        : null,
      ro: (attrs ?? "").includes("data-derive-readonly"),
      kids: [],
      parent: at,
    }
    at.kids.push(el)
    if (!VOID.has(tag)) at = el
  }
  return root.kids[0] as MdEl
}
const readsAs = (kids: (string | MdEl)[]): string =>
  kids
    .map((k) =>
      typeof k === "string"
        ? k
        : k.tag === "br"
          ? " "
          : BLOCKS.test(k.tag)
            ? ` ${readsAs(k.kids)} `
            : readsAs(k.kids),
    )
    .join("")
const squash = (s: string) => s.replace(/\s+/g, " ").trim()
/** The words of `root` with `target` reading as `words`. */
const readsWith = (root: MdEl, target: MdEl, words: string): string => {
  const walk = (el: MdEl): string => {
    if (el === target) return words
    if (el.tag === "br") return " "
    const inner = el.kids.map((k) => (typeof k === "string" ? k : walk(k))).join("")
    return BLOCKS.test(el.tag) ? ` ${inner} ` : inner
  }
  return squash(walk(root))
}
/** The words a reader sees in a Markdown document. */
const mdText = async (md: string) =>
  squash(readsAs(parseStamped(await renderMarkdown(md, null)).kids))
/** Top-level blocks: runs of non-blank lines, a fence holding its blank lines. */
const mdBlocks = (md: string): string[] => {
  const out: string[] = []
  let block: string[] = []
  let fence = false
  for (const line of md.split("\n")) {
    if (/^\s{0,3}(```|~~~)/.test(line)) fence = !fence
    if (!fence && !line.trim()) {
      if (block.length) out.push(block.join("\n"))
      block = []
    } else block.push(line)
  }
  if (block.length) out.push(block.join("\n"))
  return out
}

describe("Markdown exact-source ops", () => {
  const plain = (page: string) =>
    page.replace(/ data-derive-src(?:-version|-sha)?="[^"]*"| data-derive-readonly/g, "")

  it("stamps the reader's page with ids the source map hashes", async () => {
    const page = await renderMarkdownForEditor(ARTICLE, "Doc", { version: 4 })
    expect(plain(page)).toBe(await renderMarkdown(ARTICLE, "Doc"))
    const map = await markdownSourceMap(ARTICLE)
    expect(page).toContain(`data-derive-src-version="4" data-derive-src-sha="${map.sha}"`)
    expect(page).toContain('<main data-derive-ready data-derive-src="0">')
    const ids = [...page.matchAll(/data-derive-src="(\d+)"/g)].map((m) => Number(m[1]))
    expect(ids).toEqual(ids.map((_, i) => i))
    expect(map.hashes).toHaveLength(ids.length)
    expect(map.hashes.every((h) => /^[0-9a-f]{16}$/.test(h))).toBe(true)
    // Everything with words in it is editable in place: the article has no HTML blocks.
    expect(page).not.toContain("data-derive-readonly")
    // A construct whose text can't be mapped back exactly is served read-only.
    const odd = await renderMarkdownForEditor("Plain <sup>raw</sup> tag.\n\n- [ ] a task\n", null, {
      version: 1,
    })
    expect(odd).toMatch(/<p data-derive-src="\d+" data-derive-readonly>/)
    expect(odd).toMatch(/<li data-derive-src="\d+" data-derive-readonly>/)
  })

  it("round-trips 300 random editing sessions over the Markdown article", async () => {
    const { hashes: h } = await markdownSourceMap(ARTICLE)
    const tree = parseStamped(await renderMarkdownForEditor(ARTICLE, null, { version: 1 }))
    const all: MdEl[] = []
    const walk = (el: MdEl) => {
      all.push(el)
      for (const k of el.kids) if (typeof k !== "string") walk(k)
    }
    walk(tree)
    const keepOf = (el: MdEl, children?: SourceToken[]): SourceToken =>
      children
        ? { keep: el.src as number, hash: h[el.src as number] as string, children }
        : { keep: el.src as number, hash: h[el.src as number] as string }
    const tokensOf = (el: MdEl): SourceToken[] =>
      el.kids.map((k) => (typeof k === "string" ? { text: k } : keepOf(k)))
    const readsTokens = (list: SourceToken[]): string =>
      list
        .map((t) => {
          if ("text" in t) return t.text
          if ("tag" in t) return t.tag === "br" ? " " : readsTokens(t.children ?? [])
          if ("comment" in t) return ""
          const el = all.find((x) => x.src === t.keep) as MdEl
          if (el.tag === "br") return " "
          const inner = t.children ? readsTokens(t.children) : readsAs(el.kids)
          return BLOCKS.test(el.tag) ? ` ${inner} ` : inner
        })
        .join("")
    const TARGETS = /^(?:p|h[1-6]|li|td|th)$/
    const targets = all.filter((el) => TARGETS.test(el.tag) && el.src !== null)
    const inlineKeeps = (list: SourceToken[]) =>
      list.flatMap((t, i) => {
        if (!("keep" in t)) return []
        const el = all.find((x) => x.src === t.keep) as MdEl
        return /^(?:strong|em|a|code)$/.test(el.tag) ? [i] : []
      })
    // Typed words, including what would start a block or end a table cell if written
    // as is: the save must keep them words.
    const WORDS = [
      "zulu",
      "Quark",
      "42.",
      "- x",
      "# y",
      "> q",
      "1)",
      "a | b",
      "naïve 🙂",
      "—",
      "it's",
      "3 < 4 > 2",
      "e.g.",
      "Tab?",
    ]
    const r = rng(0x3d0c)
    const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)] as T
    const edit = (list: SourceToken[]): SourceToken[] => {
      const out = [...list]
      const texts = out.flatMap((t, i) => ("text" in t && t.text.trim() ? [i] : []))
      const kind = r()
      if (kind < 0.15 && inlineKeeps(out).length) {
        // Type inside a kept construct (a link's words, a code span, bold).
        const i = pick(inlineKeeps(out))
        const el = all.find((x) => x.src === (out[i] as { keep: number }).keep) as MdEl
        out[i] = keepOf(el, edit(tokensOf(el)))
        return out
      }
      if (kind < 0.22 && inlineKeeps(out).length) {
        out.splice(pick(inlineKeeps(out)), 1)
        return out
      }
      if (!texts.length) return [...out, { text: ` ${pick(WORDS)}` }]
      const i = pick(texts)
      const text = (out[i] as { text: string }).text
      const a = Math.floor(r() * (text.length + 1))
      const b = Math.min(text.length, a + Math.floor(r() * 12))
      if (kind < 0.55) out[i] = { text: text.slice(0, a) + pick(WORDS) + text.slice(a) }
      else if (kind < 0.75) out[i] = { text: text.slice(0, a) + text.slice(b) }
      else if (kind < 0.9 && b > a) {
        const tag = pick(["b", "i"] as const)
        out.splice(
          i,
          1,
          { text: text.slice(0, a) },
          { tag, children: [{ text: text.slice(a, b) }] },
          { text: text.slice(b) },
        )
      } else out.splice(i, 1, { text: text.slice(0, a) }, { tag: "br" }, { text: text.slice(a) })
      return out
    }
    let sessions = 0
    for (let trial = 0; trial < 300; trial++) {
      const target = pick(targets)
      const ops: SourceOp[] = []
      let expectText = ""
      const parent = target.parent as MdEl
      const splittable = /^(?:p|li)$/.test(target.tag) && parent.src !== null && r() < 0.25
      if (splittable) {
        // Enter: the parent names the block twice, each copy with its half of the words.
        const list = tokensOf(target)
        const texts = list.flatMap((t, i) => ("text" in t && t.text.length > 1 ? [i] : []))
        if (!texts.length) continue
        const i = pick(texts)
        const text = (list[i] as { text: string }).text
        const at = 1 + Math.floor(r() * (text.length - 1))
        const first = [...list.slice(0, i), { text: text.slice(0, at) }]
        const second = [{ text: text.slice(at) }, ...list.slice(i + 1)]
        const children = parent.kids.flatMap((k): SourceToken[] =>
          typeof k === "string"
            ? [{ text: k }]
            : k === target
              ? [keepOf(k, first), keepOf(k, second)]
              : [keepOf(k)],
        )
        ops.push({
          op: "content",
          src: parent.src as number,
          hash: h[parent.src as number] as string,
          children,
        })
        expectText = readsWith(tree, target, ` ${readsTokens(first)} ${readsTokens(second)} `)
      } else {
        const children = edit(tokensOf(target))
        ops.push({
          op: "content",
          src: target.src as number,
          hash: h[target.src as number] as string,
          children,
        })
        expectText = readsWith(tree, target, ` ${readsTokens(children)} `)
      }
      const label = `trial ${trial}: ${JSON.stringify(ops).slice(0, 600)}`
      let markdown: string
      try {
        ;({ markdown } = await applyMarkdownOps(ARTICLE, ops))
      } catch (e) {
        expect(String(e), label).toMatch(/nothing to save/)
        continue
      }
      sessions++
      // It reads as the edited page did: typed words stay words, escaped where needed.
      expect(await mdText(markdown), label).toBe(expectText)
      // Every block the edit didn't reach is its stored bytes, in order.
      let top: MdEl = target
      while (top.parent && top.parent !== tree) top = top.parent
      const reached = tree.kids.filter((k): k is MdEl => typeof k !== "string").indexOf(top)
      const before = mdBlocks(ARTICLE)
      const after = mdBlocks(markdown)
      let j = 0
      before.forEach((block, i) => {
        if (i === reached) return
        const at = after.indexOf(block, j)
        expect(at, `${label}\nblock ${i}`).toBeGreaterThanOrEqual(0)
        j = at + 1
      })
      // Inside a list or table, the lines of other items and rows too.
      const lines = (before[reached] as string).split("\n")
      const now = (after.find((b, i) => i >= reached && !before.includes(b)) ?? "").split("\n")
      if (/^(?:li|td|th)$/.test(target.tag) && !splittable && now.length) {
        let p = 0
        while (p < lines.length && lines[p] === now[p]) p++
        let q = 0
        while (q < lines.length - p && lines[lines.length - 1 - q] === now[now.length - 1 - q]) q++
        expect(lines.length - p - q, `${label}\n${now.join("\n")}`).toBeLessThanOrEqual(1)
      }
    }
    expect(sessions).toBeGreaterThan(250)
  }, 120_000)
})
