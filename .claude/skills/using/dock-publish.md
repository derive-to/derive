# dock-publish

Publishing content to Dock and updating it over time.

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
  visibility? "public" | "link" | "org" | "password",  // default: "link"
  for_review? boolean      // file a proposal instead of going live
)
```

Returns: `{ short_id, url, current_version }`.

Whether a `publish` goes live or files a proposal is decided by your role (Creator/Admin
publish live; a commenter role files a proposal), with `for_review:true` to force review.

**Keep the `short_id`.** It's the artifact's permanent identity. Every future version,
comment, and proposal references it.

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
npx @dock/cli publish report.html --title "Q3 report" --visibility link

# New version (pass the short_id)
npx @dock/cli publish report.html --id nk0dsral --message "Updated exec summary"
```

---

## API (curl)

```bash
# First publish
curl -X POST https://dock.build/v1/artifacts \
  -H "Authorization: Bearer $DOCK_TOKEN" \
  -F "file=@report.html" \
  -F "title=Q3 report" \
  -F "visibility=link"

# New version
curl -X POST https://dock.build/v1/artifacts/nk0dsral/versions \
  -H "Authorization: Bearer $DOCK_TOKEN" \
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

## Reading back what you published

```
read(short_id, version?)
```

Returns the source content. Omit `version` for the current version. Pass a past
`version` number to read any historical snapshot. For a bundle, pass a `section`
(page path) for one page, or omit it for the outline.

Permanent raw URL (no auth, immutable):
```
https://dock.build/raw/<short_id>/v/<n>/index.html
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
