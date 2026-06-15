# dock-markdown

Writing Markdown artifacts for Dock. Markdown is rendered server-side via
GitHub Flavored Markdown (marked) with HTML sanitization, then wrapped in a styled
full-page document with the anchor client injected.

---

## What renders

All standard GFM:

- Headings (`#` through `######`)
- Paragraphs, bold, italic, strikethrough
- Unordered and ordered lists, nested lists
- Tables (pipe syntax)
- Fenced code blocks with language tags (` ```ts `, ` ```bash `, etc.)
- Inline code
- Blockquotes
- Task lists (`- [x]` and `- [ ]`)
- Links: `[text](url)`
- Images: `![alt](url)` — src, alt, title, width, height attributes allowed
- Horizontal rules (`---`)
- Definition lists (via marked extensions)

HTML tags are sanitized. Allowed: `img`, `a`, `code`, `pre`, `input`, `th`, `td`,
`details`, `summary`, `ins`, `del`, `sup`, `sub`, plus standard block/inline elements.
Script tags and inline event handlers are stripped.

---

## Styling

Dock wraps the rendered HTML in a document with embedded CSS:
- Background: `--paper` (warm cream in the default theme)
- Font: system-ui, 16px base, 1.65 line-height
- Main column: max-width 760px, centered, generous top/bottom padding
- Code blocks: dark background (#211c33), light text, auto-scroll for wide content
- Tables: panel background, light grid lines

You don't need to provide any CSS. The document looks good out of the box.

---

## Anchor tips

Comments anchor to exact text via TextQuoteSelector. To make comments durable:

- **Keep key phrases stable across versions.** A comment anchored to "The system resolves
  ambiguities at query time" survives rewrites of surrounding sentences — but if you delete
  or rephrase that exact string, the anchor shows "text changed."
- **Use descriptive headings.** Headings appear in anchor context (prefix/suffix), so
  meaningful headings help anchors survive rewrites to nearby paragraphs.
- **Prefer real text over images of text.** The anchor system works on rendered text
  content, not pixel content. A screenshot of a table can't be commented on at the
  cell level.

---

## Code blocks

Use language tags for syntax highlighting:

````
```typescript
const res = await fetch('/v1/artifacts', { method: 'POST', body: form })
```

```bash
docker compose -f deploy/compose.yml up -d
```
````

Language-tagged blocks render with syntax highlighting in the Dock viewer.

---

## Images

Images must be publicly accessible URLs (Dock doesn't host image uploads in Markdown).
Allowed attributes: `src`, `alt`, `title`, `width`, `height`.

```markdown
![Architecture diagram](https://example.com/diagram.png)
```

---

## Task lists (good for specs and plans)

```markdown
- [x] Define the data model
- [x] Write the API routes
- [ ] Add integration tests
- [ ] Deploy to staging
```

Task list checkboxes are rendered but not interactive (checking them doesn't update
the source). Use a new `publish_version` to update task state.
