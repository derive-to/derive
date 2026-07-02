import { ThemeProvider as NextThemesProvider, useTheme as useNextTheme } from "next-themes"
import { createContext, type ReactNode, useContext, useEffect, useState } from "react"
import { api, type Me } from "./api"
import { type CursorPref, defaultPrefFor, normalizePref } from "./lib/cursors"
import { STORAGE_KEYS } from "./lib/storage-keys"

/* ---- auth ---- */
interface AuthState {
  me: Me | null
  loading: boolean
  setMe: (m: Me | null) => void
}
const AuthCtx = createContext<AuthState>({ me: null, loading: true, setMe: () => {} })
export const useAuth = () => useContext(AuthCtx)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    api
      .me()
      .then((r) => setMe(r.user))
      .catch(() => setMe(null))
      .finally(() => setLoading(false))
  }, [])
  return <AuthCtx.Provider value={{ me, loading, setMe }}>{children}</AuthCtx.Provider>
}

/* ---- theme ---- */
// Swatches are raw hex (identity color data, not theming) — see check-design-tokens.
export const THEMES = [
  { id: "light", label: "Light", sw: "#f4f5f8" },
  { id: "dark", label: "Dark", sw: "#030712" },
] as const

// next-themes owns the theme: it toggles the `.dark`/`.light` class the shadcn tokens
// key off, persists to STORAGE_KEYS.theme, and — with the head boot script in
// __root — paints the right theme before hydration. Stock <Toaster/> (sonner) reads
// this same next-themes context, so it follows the app with zero derive glue.
export function useTheme() {
  const { theme, setTheme } = useNextTheme()
  return { theme: theme ?? "dark", setTheme }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  return (
    <NextThemesProvider
      attribute="class"
      themes={["light", "dark"]}
      defaultTheme="dark"
      enableSystem={false}
      storageKey={STORAGE_KEYS.theme}
      disableTransitionOnChange
    >
      {children}
    </NextThemesProvider>
  )
}

/* ---- cursor preference (your live multiplayer cursor look) ---- */
// Persisted per-browser, exactly like the theme — so it works for anonymous
// public-link viewers too (no account, no server round-trip), and a signed-in
// user's pick is instant. The look only ever rides ephemeral cursor frames, so
// there's nothing to store server-side.
const CursorPrefCtx = createContext<{ pref: CursorPref; setPref: (p: CursorPref) => void }>({
  pref: defaultPrefFor("default"),
  setPref: () => {},
})
export const useCursorPref = () => useContext(CursorPrefCtx)

export function CursorPrefProvider({ children }: { children: ReactNode }) {
  const [pref, setPref] = useState<CursorPref>(() => {
    // Guard for the prerendered shell (no window/localStorage at build time).
    if (typeof localStorage === "undefined") return defaultPrefFor("default")
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.cursorPref)
      if (saved) return normalizePref(JSON.parse(saved), defaultPrefFor("default"))
    } catch {
      /* fall through to a fresh default */
    }
    // First visit: seed a stable-ish random look (persisted by the effect below),
    // so a viewer keeps the same cursor across reloads — Figma-style.
    return defaultPrefFor(Math.random().toString(36).slice(2))
  })
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEYS.cursorPref, JSON.stringify(pref))
    } catch {
      /* private mode / storage full — the in-memory pref still works this session */
    }
  }, [pref])
  return <CursorPrefCtx.Provider value={{ pref, setPref }}>{children}</CursorPrefCtx.Provider>
}
