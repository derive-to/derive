import * as WebBrowser from "expo-web-browser"
import { useEffect, useRef, useState } from "react"
import { ActivityIndicator, Pressable, StyleSheet, Text, useColorScheme, View } from "react-native"
import { WebView, type WebViewNavigation } from "react-native-webview"
import { AUTH_RETURN_URL, isAuthNavigation } from "./auth"
import { isInternal } from "./config"
import { tokens } from "./theme"

// How long to wait for first paint before calling the load failed. Mirrors the web
// viewer's own BOOT_TIMEOUT_MS: a stuck frame must be legible as stuck, never
// indistinguishable from "still loading".
const BOOT_TIMEOUT_MS = 15_000

/** The shell's one content surface: the existing web app, hosted.
 *
 *  Everything a person sees inside this is `apps/web`, which is why a web deploy reaches
 *  phones with no app release. The shell's job is the things a browser tab cannot do:
 *  keep external links out of the frame, and make failure and offline legible rather
 *  than a white screen. */
export function WebStage({ uri, onNavigate }: { uri: string; onNavigate?: (url: string) => void }) {
  const scheme = useColorScheme() === "dark" ? "dark" : "light"
  const t = tokens[scheme]
  const ref = useRef<WebView>(null)
  const [phase, setPhase] = useState<"booting" | "ready" | "failed">("booting")
  const [attempt, setAttempt] = useState(0)

  // Per-source: a new uri or an explicit retry starts the clock again.
  useEffect(() => {
    setPhase("booting")
    const timer = setTimeout(() => {
      setPhase((p) => (p === "booting" ? "failed" : p))
    }, BOOT_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [])

  // Which navigations the web view may follow. Fires for top-level navigations only, so
  // an artifact's own sandboxed iframe is unaffected. Three outcomes, in order:
  //
  //   1. Sign-in goes to a REAL browser, because Google rejects OAuth from an embedded
  //      web view (see ./auth). The auth session closes itself on AUTH_RETURN_URL.
  //   2. Anything else off-origin opens in the system browser, so a link can never take
  //      over the app frame.
  //   3. Our own pages load in place.
  const onShouldStart = (req: WebViewNavigation) => {
    const own = isInternal(req.url)
    if (isAuthNavigation(req.url, own)) {
      void WebBrowser.openAuthSessionAsync(req.url, AUTH_RETURN_URL).then((result) => {
        // A completed flow leaves the session in the BROWSER's cookie jar, not this web
        // view's, so a reload alone does not sign the person in. Reloading anyway is the
        // right move: it costs nothing and it picks the session up the moment the
        // token-exchange hand-off lands. Until then this is a known gap, not a bug to
        // hunt (see README, "auth handoff").
        if (result.type === "success") setAttempt((n) => n + 1)
      })
      return false
    }
    if (own) return true
    void WebBrowser.openBrowserAsync(req.url)
    return false
  }

  return (
    <View style={[styles.fill, { backgroundColor: t.background }]}>
      <WebView
        key={attempt}
        ref={ref}
        source={{ uri }}
        style={[styles.fill, { backgroundColor: t.background }]}
        // The web app owns its own pull-to-refresh and scroll model; a bounce here
        // fights the artifact viewer's locked scroll regions.
        bounces={false}
        overScrollMode="never"
        // One frame, one origin. Popups would open a chromeless window with no address
        // bar, which is exactly the shape a phishing page wants.
        setSupportMultipleWindows={false}
        onShouldStartLoadWithRequest={onShouldStart}
        onLoadEnd={() => setPhase("ready")}
        onError={() => setPhase("failed")}
        onHttpError={(e) => {
          // A 4xx/5xx on the MAIN document is a failure; sub-resource errors are the
          // page's own business and must not blank the app.
          if (e.nativeEvent.url === uri) setPhase("failed")
        }}
        onNavigationStateChange={(nav) => nav.url && onNavigate?.(nav.url)}
        // Keeps the session cookie across launches, so signing in is not a per-launch chore.
        sharedCookiesEnabled
        thirdPartyCookiesEnabled
        allowsBackForwardNavigationGestures
      />

      {phase === "booting" && (
        <View style={[styles.overlay, { backgroundColor: t.background }]}>
          <ActivityIndicator color={t.muted} />
        </View>
      )}

      {phase === "failed" && (
        <View style={[styles.overlay, { backgroundColor: t.background }]}>
          <Text style={[styles.title, { color: t.foreground }]}>Couldn&rsquo;t load Derive</Text>
          <Text style={[styles.body, { color: t.muted }]}>
            Check your connection and try again.
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              setPhase("booting")
              setAttempt((n) => n + 1)
            }}
            style={[styles.retry, { borderColor: t.border, backgroundColor: t.card }]}
          >
            <Text style={[styles.retryLabel, { color: t.foreground }]}>Try again</Text>
          </Pressable>
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  overlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    padding: 24,
  },
  title: { fontSize: 17, fontWeight: "600" },
  body: { fontSize: 14, textAlign: "center" },
  retry: {
    marginTop: 6,
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
  retryLabel: { fontSize: 14, fontWeight: "500" },
})
