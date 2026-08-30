import { Hono } from "hono"
import type { AppContext } from "../context"
import { manifestFormHTML, setupResultHTML } from "../github-app-setup"
import { encryptSecret, signState, verifyState } from "../lib/crypto"
import { convertManifestCode } from "../lib/github-app"
import { log } from "../log"

/**
 * One-click GitHub App registration (the manifest flow). /new lets the instance operator
 * choose the App owner; GitHub creates the App and redirects to /created with a
 * temporary code we trade for the App's credentials. Both are top-level navigations (not
 * the /v1 API), bound by a signed `state` carrying the initiating user. Needs an
 * encryptionKey — App secrets are never stored in the clear.
 */
export const githubAppRoutes = (ctx: AppContext) => {
  const { deps, meta, isSuperAdmin, currentUser } = ctx
  const app = new Hono()

  app.get("/settings/github/app/new", async (c) => {
    if (!deps.encryptionKey)
      return c.html(
        setupResultHTML({ ok: false, error: "Server is missing an encryption key." }),
        500,
      )
    const me = await currentUser(c)
    if (!me) return c.redirect("/login?return_to=/settings/github/app/new")
    if (!(await isSuperAdmin(c)))
      return c.html(
        setupResultHTML({
          ok: false,
          error: "Only an instance operator can configure the shared GitHub App.",
        }),
        403,
      )
    if (await meta.getGithubApp())
      return c.html(
        setupResultHTML({
          ok: false,
          error: "This Derive instance already has a GitHub App. It cannot be replaced here.",
        }),
        409,
      )
    const uid = me.id
    const state = signState({ kind: "app-manifest", uid }, deps.encryptionKey)
    return c.html(manifestFormHTML({ baseUrl: deps.baseUrl, state }))
  })

  app.get("/settings/github/app/created", async (c) => {
    const code = c.req.query("code")
    const stateRaw = c.req.query("state") ?? ""
    if (!deps.encryptionKey || !code)
      return c.html(setupResultHTML({ ok: false, error: "Missing setup code." }), 400)
    const state = verifyState<{ kind?: string; uid?: string }>(
      stateRaw,
      deps.encryptionKey,
      60 * 60 * 1000,
    )
    const me = await currentUser(c)
    if (
      state?.kind !== "app-manifest" ||
      !state.uid ||
      !me ||
      state.uid !== me.id ||
      !(await isSuperAdmin(c))
    )
      return c.html(setupResultHTML({ ok: false, error: "This setup link has expired." }), 400)
    if (await meta.getGithubApp())
      return c.html(
        setupResultHTML({
          ok: false,
          error: "Another operator already configured the GitHub App. No changes were made.",
        }),
        409,
      )
    try {
      const conv = await convertManifestCode(code)
      const key = deps.encryptionKey
      const created = await meta.createGithubApp({
        id: "default",
        app_id: conv.app_id,
        slug: conv.slug,
        client_id: conv.client_id,
        client_secret: encryptSecret(conv.client_secret, key),
        private_key: encryptSecret(conv.pem, key),
        created_at: new Date().toISOString(),
      })
      if (!created)
        return c.html(
          setupResultHTML({
            ok: false,
            error: `Another operator completed setup first. Delete the unused ${conv.slug} App on GitHub.`,
          }),
          409,
        )
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
