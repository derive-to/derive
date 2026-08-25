# Shared state for interactive artifacts

An HTML artifact can keep one or more small JSON collections in Derive. This is
useful for bug trackers, voting boards, checklists, and other mini apps that need
to stay in sync for everyone viewing the artifact.

## The API

Derive injects the `derive` global before your artifact's scripts run:

```html
<script>
  const bugs = derive.shared("bugs", [])

  bugs.onChange((items) => render(items))

  async function reportBug(title, details) {
    await bugs.add({ title, details, votes: 0 })
  }

  async function upvote(id) {
    await bugs.update(id, { votes: derive.increment(1) })
  }

  async function downvote(id) {
    await bugs.update(id, { votes: derive.increment(-1) })
  }
</script>
```

`derive.shared(key, initial)` returns the same collection handle each time it is
called with that key. `onChange` runs immediately with `initial`, then again when
the persisted value loads or another viewer changes it. `add` gives a new object
a server-generated `id`. `update` shallowly patches the object with that id. Call
`add` and `update` from a real click or keyboard interaction; Derive rejects
load-time writes so an artifact cannot attribute changes to someone who only viewed it.

For an honest loading or error state, await the handle's `ready` promise. The
local initial value remains available immediately, while a failed first read is
observable instead of looking like an empty collection:

```js
bugs.ready.then(showBoard).catch((error) => showLoadError(error.message))
```

Use `await bugs.activity()` to read the latest attributed interactions (the
recent 50 are retained):

```js
const activity = await bugs.activity()
// [{ action: "update", item_id: "item_…", actor: { id, name }, at, version }]
```

The server derives the actor from the signed-in Derive principal. Artifact code
never supplies identity, so a user cannot claim somebody else's action.

## Permissions

Shared state reuses the artifact's existing roles:

- Viewers can read and receive live state.
- Commenters can add items, apply atomic `+1` / `-1` counter interactions, and
  read activity.
- Editors and owners can also replace fields with an arbitrary shallow update
  and use larger atomic increments.

There is no separate “interact” permission. A general-access comment link lets a
signed-in visitor interact; anonymous visitors remain viewers, matching Derive's
normal comment rules.

## Limits

This is intentionally a small-state primitive, not a database API. An artifact
may use up to 16 keys; each key holds an array of up to 2,000 JSON objects and
256 KB. Keys start with a letter and may contain letters, numbers, `_`, or `-`
(up to 64 characters). Updates use optimistic concurrency so simultaneous votes
are applied without silently overwriting one another. Treat a key as the data
shape boundary: move an incompatible redesign to a new key such as `bugs_v2`.
