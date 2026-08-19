---
title: Share a URL with an agent and it reads the document
description: Every artifact link now answers with markdown when an agent asks for it. No token, no API client, and no scraping the app shell.
date: 2026-08-19
---

Paste an artifact link into an agent and, until recently, one of two things happened. Either the agent had Derive connected over MCP and read the document properly, or it fetched the URL like a browser and got the application shell: a page whose content arrives later, in JavaScript it never runs.

The link worked for people and failed for the reader you actually wanted to hand it to.

## What changed

Every `/artifacts/<ref>` share URL now serves a markdown projection of the document. Ask for it with a header:

```
curl -H "Accept: text/markdown" https://derive.to/artifacts/<ref>
```

Or ask for it in the URL, which is easier to paste into a prompt:

```
https://derive.to/artifacts/<ref>.md
```

A pinned version works the same way:

```
https://derive.to/artifacts/<ref>@v3.md
```

No credentials are involved. If the link is one you could open in a browser, it is one an agent can read.

## The access rules did not move

The projection is a new way to read the same document, not a new door into it. A password-locked link still has to be unlocked on the web page first. A pinned version other than the current one still needs a signed-in reader, unless the artifact publishes its history. Anything the link could not show a person, it will not show an agent.

## Why markdown

Because it is the document, not a description of it. A JSON envelope would have made us pick which parts of an artifact matter, and every agent would then have had to reassemble prose we had just taken apart. Markdown is what a model reads well and what a person can still open in an editor. It is also what our own agent integrations already consume, so there is one projection to keep honest instead of two.

## The part that is still rough

Some fetchers send no markdown preference at all and follow no links. Those still receive the application shell, and they still see very little. If the agent you care about is one of them, use the `.md` suffix. It is a plain URL, it needs no headers, and it is the form we would recommend in a prompt anyway.
