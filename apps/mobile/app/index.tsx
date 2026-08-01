import * as Linking from "expo-linking"
import { useEffect, useRef, useState } from "react"
import { StyleSheet, useColorScheme, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { WEB_ORIGIN, webUrlFromDeepLink } from "../src/config"
import { TabBar } from "../src/tab-bar"
import { activeTabFor, navScript } from "../src/tabs"
import { tokens } from "../src/theme"
import { WebStage } from "../src/web-stage"

/** The app: the hosted web app, plus deep-link entry.
 *
 *  Deep links are the reason this screen owns a `uri` in state rather than just
 *  rendering WEB_ORIGIN. A notification tap or a `derive://` link from a host app's
 *  in-app browser has to land on the exact artifact, including from a COLD start,
 *  which is the case that is easy to miss: `getInitialURL` covers the launch, the
 *  listener covers the app already being open. */
export default function Home() {
  const insets = useSafeAreaInsets()
  const t = tokens[useColorScheme() === "dark" ? "dark" : "light"]
  const [uri, setUri] = useState(WEB_ORIGIN)
  // What the PAGE is painting, which is not the same question as what the OS appearance
  // is: the web app resolves its own theme (a stored choice first, the OS only as a
  // fallback), so a phone in light mode can be showing a dark-themed app. Until the page
  // reports in, the device tokens are the best guess available.
  const [pageBg, setPageBg] = useState<string | null>(null)
  // Where the hosted app currently is, so the tab bar can show it. Fed by the web view's
  // own navigation events, which means the bar follows in-app links too, not just taps.
  const [url, setUrl] = useState(WEB_ORIGIN)
  // A handle rather than a prop: re-rendering the web view to pass a command would reload
  // the page, which is the exact thing a tab switch must not do.
  const run = useRef<((js: string) => void) | null>(null)

  useEffect(() => {
    let cancelled = false

    // Cold start: the link that launched the app.
    void Linking.getInitialURL().then((initial) => {
      if (cancelled || !initial) return
      const target = webUrlFromDeepLink(initial)
      if (target) setUri(target)
    })

    // Already running: a link arriving while the app is foregrounded or backgrounded.
    const sub = Linking.addEventListener("url", ({ url }) => {
      const target = webUrlFromDeepLink(url)
      if (target) setUri(target)
    })

    return () => {
      cancelled = true
      sub.remove()
    }
  }, [])

  // Only the TOP inset is applied. The bottom is left to the web app, which already pads
  // its docked surfaces with env(safe-area-inset-bottom) (the comments sheet, the
  // selection bar) — adding a native gap under them would double it.
  //
  // The strip MUST carry the page's background, and the PAGE is the only honest source
  // for it. Unpainted it renders platform grey; painted from the device colour scheme it
  // is still wrong whenever the two disagree, which they do — the web app resolves its
  // own theme, so a phone in light mode showing a dark-themed app produced a white band
  // above black chrome. The page reports its computed background (BACKGROUND_PROBE) and
  // this follows it, including through an in-app theme toggle.
  return (
    <View style={[styles.fill, { backgroundColor: pageBg ?? t.background }]}>
      <View style={[styles.fill, { paddingTop: insets.top }]}>
        <WebStage uri={uri} runRef={run} onNavigate={setUrl} onBackground={setPageBg} />
      </View>
      {/* Below the web view, not over it: the hosted app docks its own surfaces at the
          bottom (the comments sheet) and an overlaid bar would cover them. */}
      <TabBar
        active={activeTabFor(url)}
        onSelect={(path) => run.current?.(navScript(path))}
        t={pageBg ? { ...t, background: pageBg } : t}
      />
    </View>
  )
}

const styles = StyleSheet.create({ fill: { flex: 1 } })
