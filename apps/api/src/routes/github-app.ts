import { Hono } from "hono"
import type { AppContext } from "../context"
import { manifestFormHTML, setupResultHTML } from "../github-app-setup"
import { encryptSecret, signState, verifyState } from "../lib/crypto"
import { convertManifestCode } from "../lib/github-app"
import { log } from "../log"

/**
 * One-click GitHub App registration (the manifest flow). /new renders the auto-submitting
 * manifest form (admins only); GitHub creates the App and redirects to /created with a
 * temporary code we trade for the App's credentials. Both are top-level navigations (not
 * the /v1 API), bound by a signed `state` carrying the initiating user. Needs an
 * encryptionKey — App secrets are never stored in the clear.
 */
export const githubAppRoutes = (ctx: AppContext) => {
  const { deps, meta, workspaceCan, currentUser } = ctx
  const app = new Hono()

  app.get("/settings/github/app/new", async (c) => {
    if (!deps.encryptionKey)
      return c.html(
        setupResultHTML({ ok: false, error: "Server is missing an encryption key." }),
        500,
      )
    if (!(await workspaceCan(c, "publish")))
      return c.redirect("/login?return_to=/settings/github/app/new")
    const uid = (await currentUser(c))?.id ?? "anon"
    const state = signState({ kind: "app-manifest", uid }, deps.encryptionKey)
    return c.html(manifestFormHTML({ baseUrl: deps.baseUrl, state }))
  })

  app.get("/settings/github/app/created", async (c) => {
    const code = c.req.query("code")
    const stateRaw = c.req.query("state") ?? ""
    if (!deps.encryptionKey || !code)
      return c.html(setupResultHTML({ ok: false, error: "Missing setup code." }), 400)
    const state = verifyState<{ kind?: string }>(stateRaw, deps.encryptionKey)
    if (state?.kind !== "app-manifest")
      return c.html(setupResultHTML({ ok: false, error: "This setup link has expired." }), 400)
    try {
      const conv = await convertManifestCode(code)
      const key = deps.encryptionKey
      await meta.setGithubApp({
        id: "default",
        app_id: conv.app_id,
        slug: conv.slug,
        client_id: conv.client_id,
        client_secret: encryptSecret(conv.client_secret, key),
        private_key: encryptSecret(conv.pem, key),
        webhook_secret: encryptSecret(conv.webhook_secret, key),
        created_at: new Date().toISOString(),
      })
      return c.html(setupResultHTML({ ok: true, slug: conv.slug }))
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      log.error("github app manifest conversion failed", { error: detail })
      return c.html(
        setupResultHTML({ ok: false, error: `Could not create the GitHub App. ${detail}` }),
        502,
      )
    }
  })

  return app
}
