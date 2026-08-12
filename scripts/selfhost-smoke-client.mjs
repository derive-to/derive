#!/usr/bin/env node

// HTTP half of the self-host smoke test. Drive the public API like a browser instead of
// reaching into SQLite, so a green test proves that bootstrap credentials, cookies, signup
// policy, publishing, blob reads, and restored data all agree at the deployed boundary.

const mode = process.argv[2]
const origin = process.env.DERIVE_SMOKE_ORIGIN
const email = process.env.DERIVE_SMOKE_EMAIL
const password = process.env.DERIVE_SMOKE_PASSWORD

if (!origin || !email || !password || !["publish", "verify"].includes(mode))
  throw new Error(
    "usage: DERIVE_SMOKE_ORIGIN=... DERIVE_SMOKE_EMAIL=... " +
      "DERIVE_SMOKE_PASSWORD=... selfhost-smoke-client.mjs publish|verify",
  )

const expectedContent =
  "<!doctype html><title>Quick-start recovery proof</title><h1>Recovered content</h1>"

const expect = (condition, message) => {
  if (!condition) throw new Error(message)
}

const responseText = async (response) => `${response.status} ${await response.text()}`
const expectStatus = async (response, status, label) => {
  if (response.status !== status)
    throw new Error(`${label}: expected ${status}, received ${await responseText(response)}`)
}

const health = await fetch(`${origin}/healthz`)
await expectStatus(health, 200, "health check failed")
const healthBody = await health.json()
expect(healthBody.ok === true && typeof healthBody.build === "string", "malformed /healthz")

const readiness = await fetch(`${origin}/readyz`)
await expectStatus(readiness, 200, "readiness check failed")
expect((await readiness.json()).ok === true, "malformed /readyz")

const app = await fetch(`${origin}/`)
await expectStatus(app, 200, "SPA request failed")
expect((await app.text()).toLowerCase().includes("<!doctype html>"), "SPA response is not HTML")

const authHeaders = { "content-type": "application/json", origin }
let response = await fetch(`${origin}/api/auth/sign-in/email`, {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({ email, password }),
})
await expectStatus(response, 200, "operator sign-in failed")
const setCookie = response.headers.getSetCookie?.()[0] ?? response.headers.get("set-cookie") ?? ""
expect(setCookie.length > 0, "operator sign-in returned no session cookie")
const cookie = setCookie.split(";", 1)[0]

response = await fetch(`${origin}/api/auth/get-session`, { headers: { cookie, origin } })
await expectStatus(response, 200, "session read failed")
const session = await response.json()
expect(session.user?.email === email, "session belongs to the wrong operator")

if (mode === "publish") {
  response = await fetch(`${origin}/api/auth/sign-in/email`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ email, password: `${password}-wrong` }),
  })
  expect(response.status >= 400, "an incorrect operator password was accepted")

  response = await fetch(`${origin}/api/auth/sign-up/email`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      email: `uninvited-${email}`,
      password,
      name: "Uninvited",
    }),
  })
  const signupBody = await response.json()
  expect(
    response.status === 403 && signupBody.code === "SIGNUP_NOT_ALLOWED",
    `invite-only signup was not rejected: ${response.status} ${JSON.stringify(signupBody)}`,
  )

  const form = new FormData()
  form.append("file", new Blob([expectedContent], { type: "text/html" }), "recovery-proof.html")
  form.append("title", "Quick-start recovery proof")
  response = await fetch(`${origin}/v1/artifacts`, {
    method: "POST",
    headers: { accept: "application/json", cookie, origin },
    body: form,
  })
  const artifact = await response.json()
  expect(response.status === 201, `artifact publish failed: ${JSON.stringify(artifact)}`)
  expect(/^[a-z0-9]+$/.test(artifact.short_id ?? ""), "publish returned no valid short id")

  response = await fetch(`${origin}/v1/artifacts/${artifact.short_id}/content`, {
    headers: { cookie },
  })
  await expectStatus(response, 200, "artifact read failed")
  expect((await response.text()) === expectedContent, "published artifact content changed")
  process.stdout.write(artifact.short_id)
} else {
  const artifactId = process.env.DERIVE_SMOKE_ARTIFACT_ID
  expect(/^[a-z0-9]+$/.test(artifactId ?? ""), "verify mode needs DERIVE_SMOKE_ARTIFACT_ID")
  response = await fetch(`${origin}/v1/artifacts/${artifactId}/content`, { headers: { cookie } })
  await expectStatus(response, 200, "restored artifact read failed")
  expect((await response.text()) === expectedContent, "restored artifact content changed")
}
