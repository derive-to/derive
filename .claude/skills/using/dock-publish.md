# dock-publish

Publishing content to Dock and updating it over time.

---

## First publish: publish_artifact

Use this once per piece of content to create the artifact and get its permanent `short_id`.

```
publish_artifact(
  content:    string,      // full file content (HTML or Markdown)
  filename:   string,      // e.g. "report.html" or "notes.md" — determines artifact type
  title?:     string,      // display title in the workspace
  slug?:      string,      // custom URL slug
  visibility? "public" | "link" | "org" | "password"  // default: "link"
)
```

Returns: `{ short_id, url, current_version }`.

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

## Subsequent versions: publish_version

Use this every time you revise the content. Same URL, incremented version number.

```
publish_version(
  short_id:  string,        // from the original publish_artifact call
  content:   string,        // full revised content
  filename:  string,        // same as before (e.g. "report.html")
  message?:  string,        // changelog note ("Fixed the intro section")
  resolves?: string[]       // comment IDs to close in the same operation
)
```

Passing `resolves` is the canonical way to close feedback: the threads flip to resolved
atomically with the publish, so reviewers can see exactly which version addressed their comment.

**Don't create a new artifact when you mean to version.** Each `publish_artifact` call
creates a brand new artifact with a new URL. Use `publish_version` to update existing content.

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
get_artifact(short_id, version?)
```

Returns metadata + full source content. Omit `version` for the current version.
Pass a past `version` number to read any historical snapshot.

Permanent raw URL (no auth, immutable):
```
https://dock.build/raw/<short_id>/v/<n>/index.html
```

---

## Versions

Every `publish_version` call creates an immutable snapshot. Version numbers start at 1.

```
list_versions(short_id)
```
Returns `[{ n, author, message, created_at }]`, newest first.

```
diff_versions(short_id, from?, to?)
```
Defaults to previous vs current. Returns `{ ops: [{ t: "add"|"del"|"ctx", line }] }`.

```
restore_version(short_id, version)
```
Creates a new version pointing to the old blob. History is never deleted.
