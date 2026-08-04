---
name: assets
summary: stage image/font bytes, choose the permanent URL or bundle ref, publish the reference, and verify the render (stage, publish, read)
order: 5
---
# Staging assets in Derive

Use `stage({ target: "asset" })` for binary images and web fonts that an artifact
embeds. Staging moves raw bytes from a local file to Derive without putting them through
model context. Staging alone does not create an artifact or a version: stage first, then
reference the result in `publish`.

## Supported assets

- Raster images: PNG, JPEG, GIF, and WebP.
- Web fonts: WOFF and WOFF2.
- Maximum size: 25 MB per file.
- Do not stage SVG, HTML, CSS, JavaScript, PDFs, or arbitrary binaries as assets. Keep
  inline SVG/CSS/JS in the page source; use `stage({ target: "doc" })` for a large
  document or zip bundle.

## Required workflow

1. Make sure the bytes exist as a local, byte-readable file. A pasted screenshot normally
   already has a local path supplied by the client. Never transcribe or base64-encode it
   into a tool argument. If no byte-capable path exists, ask the user to attach or expose
   the file.
2. Call `stage({ target: "asset", workspace? })`. Do not pass `short_id`: assets are
   content-addressed, not versioned. The response gives `upload_url`, expiry, size limit,
   and accepted MIME types.
3. Treat `upload_url` as a short-lived credential. From the shell, POST the file's raw
   bytes with no bearer token:

   ```bash
   curl -sS -X POST -H "Content-Type: image/png" --data-binary @shot.png "<upload_url>"
   ```

   Use the matching MIME type for fonts or other image formats. One minted upload URL may
   accept multiple files until it expires; each POST returns its own asset result.
4. Capture the upload response: `{ key, url, ref, type, size, width, height, cost }`.
   - `cost` names what this asset costs every viewer on every load, with its pixel
     dimensions. READ IT. Nothing is re-encoded (they are your bytes), but a screenshot
     exported at twice the density it displays at is the common, invisible way a page
     gets slow — and halving the density is the lever (~78% smaller, where re-encoding
     buys ~15%). A publish whose page references more than ~1MB of assets says so too.
   - Use permanent `url` in single-file HTML `<img src>`, CSS `url()`, Markdown
     `![]()`, or anywhere a URL is required.
   - Use `ref` (the exact `asset:<hash>` value) as a binary entry in a bundle's
     `publish.files` map, for example `{ "images/shot.png": "asset:<hash>" }`, then
     reference `images/shot.png` relatively from the bundle's pages.
   - Do not put `upload_url` into the artifact. It expires; `url` and `ref` are the
     durable results.
5. Call `publish` with the content or bundle that references the staged asset. For a
   bundle revision, use `merge:true` when sending only new asset paths; otherwise a plain
   bundle publish replaces every file.
6. Inspect the result with `read({ short_id, render: "top", wait: 30 })` or
   `render:"full"`. A successful upload does not prove the path, CSS, font declaration,
   or rendered layout is correct.

## Security and recovery

The returned permanent `url` is an unguessable public capability URL: anyone who receives
that exact URL can fetch the bytes independently of the artifact's visibility. Do not
stage a sensitive asset unless that sharing model is acceptable.

If the upload URL expired, call `stage` again and retry the raw-byte upload. If staging is
denied, do not improvise a base64 fallback: the actor needs publish permission, the target
workspace must be correct, and a self-hosted server needs its signing secret configured.
