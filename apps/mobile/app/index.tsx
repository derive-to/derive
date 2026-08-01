import * as Linking from "expo-linking"
import { useEffect, useState } from "react"
import { StyleSheet, useColorScheme, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { WEB_ORIGIN, webUrlFromDeepLink } from "../src/config"
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
  // The strip MUST carry the theme background. Left unpainted it renders as the default
  // platform grey, which reads as a broken app before a single pixel of content loads: a
  // dead band above chrome that is trying to look continuous with it. The web app has no
  // safe-area-inset-TOP handling, so this really is the shell's to paint, and it has to
  // track the colour scheme or it is wrong in one theme or the other.
  return (
    <View style={[styles.fill, { paddingTop: insets.top, backgroundColor: t.background }]}>
      <WebStage uri={uri} />
    </View>
  )
}

const styles = StyleSheet.create({ fill: { flex: 1 } })
