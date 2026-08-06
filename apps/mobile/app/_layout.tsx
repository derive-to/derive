import { Stack } from "expo-router"
import { StatusBar } from "expo-status-bar"
import { SafeAreaProvider } from "react-native-safe-area-context"

// The shell has one screen today: the hosted web app. The native tab bar comes next,
// and is deliberately not guessed at here — it needs a device to get the feel right,
// and the mechanism that makes a tab switch not read as a page load (driving the SPA's
// client-side router rather than reloading the web view) is exactly the sort of thing
// that has to be tried rather than reasoned about. See README.
export default function RootLayout() {
  return (
    <SafeAreaProvider>
      {/* The web app paints its own background under the status bar, so the bar just
          follows the system appearance. */}
      <StatusBar style="auto" />
      <Stack screenOptions={{ headerShown: false }} />
    </SafeAreaProvider>
  )
}
