import * as Linking from "expo-linking"
import { useEffect, useState } from "react"
import { StyleSheet, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { WEB_ORIGIN, webUrlFromDeepLink } from "../src/config"
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

  // Only the TOP inset is applied. The bottom is left to the web app so its own docked
  // surfaces (the artifact page's comments sheet) sit flush against the home indicator
  // instead of floating above a native gap.
  return (
    <View style={[styles.fill, { paddingTop: insets.top }]}>
      <WebStage uri={uri} />
    </View>
  )
}

const styles = StyleSheet.create({ fill: { flex: 1 } })
