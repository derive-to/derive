The fastest proof is an anonymous draft. It needs no account or token:

```bash
curl -F file=@page.html https://derive.to/v1/drafts
```

You can upload one HTML or Markdown file, or a ZIP whose root contains `index.html`.
The response includes:

- `draft_url`: the live, read-only page;
- `claim_url`: a private link that moves it into your workspace; and
- `expires_at`: 72 hours after creation.

Do not publish secrets or private customer data through an anonymous draft. Anyone with
the draft URL can view it until it expires.

## Make the artifact durable

Open the claim URL, sign in, and confirm the claim. The draft becomes a normal workspace
artifact with version history, sharing controls, comments, and review rounds.

For durable publishing directly from a terminal:

```bash
npx -y @derive-to/cli login
npx -y @derive-to/cli publish page.html --title "Launch page"
```

Publishing the same project again creates a new version at the existing URL. See the
[CLI guide](/agents/cli/) for project configuration and access flags.

## What to publish first

Choose something worth finding again: a launch page, research brief, report, designed plan,
demo, or handoff. A blank test document proves transport; a real artifact shows the value of
a durable link, readable history, and a place to continue the work.

If you want a complete starting point, use an [official example](/artifacts/examples/).
