# derive-publish

Publishing content to Derive and updating it over time.

---

## Publish

`publish` is the one tool for saving content. Omit `short_id` to create a new artifact
and get its permanent `short_id`; pass `short_id` to add a version (see below).

```
publish(
  content:    string,      // full file content for a single file (HTML or Markdown)
  files?:     object,      // path -> content map for a multi-page bundle
  filename:   string,      // e.g. "report.html" or "notes.md" — determines artifact type
  title?:     string,      // display title (required when creating a new artifact)
  slug?:      string,      // custom URL slug
  visibility? "unlisted" | "public" | "link" | "org" | "password" | "private",
              // default for agent publishes: "unlisted" (hidden from the library,
              // one link away for workspace members — the draft state)
  request_review? boolean  // open a review round for your human (the /derive loop)
)
```

Returns: `{ short_id, url, current_version, opened_in_tab?, review_requested? }` —
`opened_in_tab` says whether an open Derive tab caught the push (false ⇒ open the
url for the user if they should see it now).

Every `publish` goes live as a new kept version. It needs publish standing (editor or
owner); a lower role suggests the change in a comment for someone who can publish.

**Keep the `short_id`.** It's the artifact's permanent identity. Every future version,
comment, and review round references it.

### Visibility

| Value | Who can read |
|---|---|
| `public` | Anyone on the internet, no auth required |
| `link` | Anyone who has the URL (default) |
| `org` | Workspace members only |
| `password` | Anyone who unlocks it with the correct password |

---

## Subsequent versions: publish with a short_id

Pass `short_id` to `publish` every time you revise the content. Same URL, incremented
version number.

```
publish(
  short_id:  string,        // from the original publish call
  content:   string,        // full revised content
  filename:  string,        // same as before (e.g. "report.html")
  message?:  string,        // changelog note ("Fixed the intro section")
  addresses? string[]       // thread IDs to resolve in the same operation
)
```

Passing `addresses` is the canonical way to close feedback: the threads flip to resolved
atomically with the publish, so reviewers can see exactly which version addressed their comment.

**Don't create a new artifact when you mean to version.** A `publish` without `short_id`
creates a brand new artifact with a new URL. Pass `short_id` to update existing content.

---

## CLI

```bash
# First publish
npx @derive-to/cli publish report.html --title "Q3 report" --visibility link

# New version (pass the short_id)
npx @derive-to/cli publish report.html --id nk0dsral --message "Updated exec summary"
```

---

## API (curl)

```bash
# First publish
curl -X POST https://derive.to/v1/artifacts \
  -H "Authorization: Bearer $DERIVE_TOKEN" \
  -F "file=@report.html" \
  -F "title=Q3 report" \
  -F "visibility=link"

# New version
curl -X POST https://derive.to/v1/artifacts/nk0dsral/versions \
  -H "Authorization: Bearer $DERIVE_TOKEN" \
  -F "file=@report.html" \
  -F "message=Updated exec summary" \
  -F "resolves=c_abc123,c_def456"
```

---

## What the filename determines

The `filename` parameter is a hint for content type detection:

- `*.md` → Markdown artifact (rendered via GFM + sanitization)
- `*.html` → HTML artifact (served in sandbox)
- `*.html` with `<section class="slide">` elements → HTML deck (gets nav + present mode)
- `*.zip` → Bundle (multi-file site)

---

## Images in ANY artifact (the cheap way)

Never inline a base64 `data:` URI to embed a screenshot — it tokenizes at roughly 1
token/char, so one modest PNG can cost 100k+ tokens to pass through a tool call or
read back. Instead, upload the raw bytes once and get a permanent public URL:

```
# 1. Stream the bytes up as binary — no base64, nothing to transcribe.
curl -s -X POST "$DERIVE_URL/v1/assets" \
  -H "authorization: Bearer $DERIVE_TOKEN" \
  -H "content-type: image/png" \
  --data-binary @shot.png
# → { "key": "9f86d081…", "url": "https://derive.to/blob/9f86d081….png",
#     "ref": "asset:9f86d081…", "type": "image/png", "size": 20531 }

# 2. Paste the url straight into the content — works in a SINGLE-FILE artifact,
#    a bundle page, or markdown — it's just a normal <img src> / ![]() target:
publish(content = '<img src="https://derive.to/blob/9f86d081….png">')
```

`url` is a permanent, content-addressed capability link (the hash is unguessable, so
it's effectively private, but it's not gated by the artifact's own visibility the way
`/raw/...` bytes are — don't use it for anything that must stay strictly access-controlled).
It never expires and never changes for the same bytes (re-uploading identical bytes is a
free no-op). `POST /v1/assets` accepts a raw binary body (as above) or a multipart `file`
field. Supported: PNG, JPEG, GIF, WebP (max 25 MB each; SVG is rejected).

## Images & binary assets in a bundle

A bundle's `files` map carries binary assets (screenshots, images, fonts) alongside the
HTML/CSS/JS pages. Each `files` value is one of:

- **text** — a plain string (a page).
- **base64 data URI** — `"shot.png": "data:image/png;base64,iVBORw0K…"`. Avoid for real
  screenshots (see above) — fine only for a tiny inline icon.
- **the same `url` from above**, used as any page's `<img src>` — works in a bundle too.
- **asset handle** — `"shot.png": "asset:9f86d081…"` (the same upload's `ref`), baked
  into the bundle as its own file at that path instead of linked externally:

  ```
  publish(files = {
    "index.html": "<img src=shot.png>",
    "shot.png":   "asset:9f86d081…"
  })
  ```

  Once published, that page serves at `https://derive.to/raw/<short_id>/v/<n>/shot.png`
  (gated by the doc's own visibility, unlike the public `/blob/...` url above).

  Mix and match as needed: the public `url` for the simple case, `asset:` handles when
  the image must inherit the doc's own access control.

---

## Reading back what you published

```
read(short_id, version?)
```

Returns the source content. Omit `version` for the current version. Pass a past
`version` number to read any historical snapshot. For a bundle, pass a `section`
(page path) for one page, or omit it for the outline.

Permanent raw URL (no auth, immutable):
```
https://derive.to/raw/<short_id>/v/<n>/index.html
```

---

## Versions

Every `publish` with a `short_id` creates an immutable snapshot. Version numbers start at 1.

Version history, the line diff, and what changed are all surfaced by `catch_up`:

```
catch_up(short_id)                                  # version history + open threads
catch_up(short_id, response_format='detailed',
         since_version, to_version)                 # fold in the exact line diff
```

History returns `[{ n, author, message, created_at }]`, newest first; the detailed diff
returns `{ ops: [{ t: "add"|"del"|"ctx", line }] }`.

To roll back, `publish` the old version's content as a new version (pass `short_id`).
History is never deleted.
