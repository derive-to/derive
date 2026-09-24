import { decodeHTML } from "entities"
import { describe, expect, it } from "vitest"
import { attrValues, tags } from "../src/html-tags"
import { escapeHtml } from "../src/md"
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
