import { Logo } from "@/components/shared/logo"
import { Card, CardContent } from "@/components/ui/card"
import { useAuth } from "@/ctx"
import { suggestUsername } from "@/lib/username"
import { UsernameForm } from "./username-form"

// Shown by the app shell when a signed-in user has no handle yet (new account, or
// an existing one from before usernames). Claiming one lets them into the app —
// setMe updates the gate. Pre-fills a suggestion from their name/email.
export function UsernameOnboarding() {
  const { me, setMe } = useAuth()
  if (!me) return null
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-1.5 text-center">
          <Logo size={30} />
          <h1 className="mt-2 font-display text-2xl font-semibold text-foreground">
            Pick your username
          </h1>
          <p className="text-sm text-muted-foreground">
            It's how people find, @mention, and share with you on Dock. You can change it later.
          </p>
        </div>
        <Card>
          <CardContent className="pt-6">
            <UsernameForm
              initial={suggestUsername(me.name ?? me.email)}
              submitLabel="Claim username"
              onClaimed={(username) => setMe({ ...me, username })}
            />
          </CardContent>
        </Card>
      </div>
    </main>
  )
}
