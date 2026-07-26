import { Logo } from "./logo"

// The cold-boot frame. Route-agnostic and identity-free by design: it is what the
// prerendered static shell renders (replacing the old baked-in full-screen
// spinner) AND what the AppFrame hydration gate shows on the first client paint —
// so the two match exactly and hydration is clean. One calm brand breath on the
// app canvas, then route-correct chrome takes over a tick later (never gated on
// the me() query). A one-time frame: in-app navs keep the chrome mounted and
// never see it. Pure — no window/localStorage/theme read; the tokens resolve from
// the .dark class the boot script already set, so it's identical server↔client.
export function AppBoot() {
  return (
    <div className="grid h-full place-items-center bg-background">
      <span role="status" aria-label="Loading Derive" className="animate-pulse text-foreground/80">
        <Logo size={40} />
      </span>
    </div>
  )
}
