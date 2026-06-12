import { createContext, useContext, useEffect, useState, type ReactNode } from "react"
import { api, type Me } from "./api"

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
export const THEMES = [
  { id: "paper", label: "Paper", sw: "#f6f0e3" },
  { id: "light", label: "Light", sw: "#ffffff" },
  { id: "dark", label: "Dark", sw: "#0f0f10" },
  { id: "dusk", label: "Dusk", sw: "#241e3a" },
] as const

const ThemeCtx = createContext<{ theme: string; setTheme: (t: string) => void }>({
  theme: "paper",
  setTheme: () => {},
})
export const useTheme = () => useContext(ThemeCtx)

export function ThemeProvider({ children }: { children: ReactNode }) {
  // Guard for the prerendered shell (no window/localStorage at build time).
  const [theme, setTheme] = useState(() =>
    typeof localStorage === "undefined" ? "paper" : (localStorage.getItem("dock_theme") ?? "paper"),
  )
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem("dock_theme", theme)
  }, [theme])
  return <ThemeCtx.Provider value={{ theme, setTheme }}>{children}</ThemeCtx.Provider>
}
