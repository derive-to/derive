import { Pressable, StyleSheet, Text, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { TABS } from "./tabs"
import type { Tokens } from "./theme"

/**
 * The shell's native tab bar.
 *
 * Deliberately glyph-free. An icon set is a dependency, a bundle cost and a design
 * decision, and this needs none of the three to do its job: four short words read
 * unambiguously at this size, and the type is the app's own. If icons earn their place on
 * a device later, they slot in above the labels without moving anything else.
 *
 * Colours come from the PAGE, not the device: the bar sits flush against web content, and
 * the two disagreeing is exactly the bug that made the safe-area strip look broken twice.
 */
export function TabBar({
  active,
  onSelect,
  t,
}: {
  /** Tab key, or null where no tab owns the current path (an artifact, a profile). */
  active: string | null
  onSelect: (path: string) => void
  t: Tokens
}) {
  const insets = useSafeAreaInsets()
  return (
    <View
      style={[
        styles.bar,
        {
          backgroundColor: t.background,
          borderTopColor: t.border,
          // The home indicator sits below the row; padding it here rather than sizing the
          // row keeps the touch targets a full 44pt on every device.
          paddingBottom: insets.bottom,
        },
      ]}
    >
      {TABS.map((tab) => {
        const on = tab.key === active
        return (
          <Pressable
            key={tab.key}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            accessibilityLabel={tab.label}
            testID={`tab-${tab.key}`}
            onPress={() => onSelect(tab.path)}
            style={styles.tab}
            // A tab press should feel immediate; the web nav it triggers is instant.
            android_ripple={{ color: t.border, borderless: true }}
          >
            <Text
              numberOfLines={1}
              style={[
                styles.label,
                { color: on ? t.foreground : t.muted, fontWeight: on ? "600" : "500" },
              ]}
            >
              {tab.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  bar: { flexDirection: "row", borderTopWidth: StyleSheet.hairlineWidth },
  // 44pt is Apple's minimum touch target; the row is sized so each tab clears it.
  tab: { flex: 1, alignItems: "center", justifyContent: "center", minHeight: 48, paddingTop: 6 },
  label: { fontSize: 11, letterSpacing: 0.2 },
})
