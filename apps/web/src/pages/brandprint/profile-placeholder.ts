// The brand-profile placeholder: version 1 of the workspace's "Brand profile"
// artifact, published by the intake so the agent has a fixed short_id to file its
// build to (spec: the placeholder is the recognition contract). The profile
// counts as live from version 2, so this stub is what renders until then.
const PROFILE_PLACEHOLDER_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Brand profile</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    background: #faf9f7; color: #1c1b1a;
  }
  @media (prefers-color-scheme: dark) { body { background: #171614; color: #f0eee9; } }
  main { max-width: 420px; text-align: center; padding: 24px; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p { margin: 0; opacity: .7; }
</style>
</head>
<body>
<main>
  <h1>Brand profile</h1>
  <p>This brand profile hasn't been generated yet. Your agent builds it from the source
  documents in this Brandprint.</p>
</main>
</body>
</html>
`

export const placeholderFile = () =>
  new File([PROFILE_PLACEHOLDER_HTML], "Brand profile.html", { type: "text/html" })
