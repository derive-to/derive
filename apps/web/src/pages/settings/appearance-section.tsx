import { useState } from "react"
import { ThemeSwitch } from "@/components/chrome/theme-switch"
import { SettingRow } from "@/components/shared/setting-row"
import { SettingsGroup } from "@/components/shared/settings-group"
import { Switch } from "@/components/ui/switch"
import { STORAGE_KEYS } from "@/lib/storage-keys"
import { SettingsSection } from "./settings-section"

// Personal appearance — theme lives here as its source-of-truth control (a quick
// toggle also rides the account pod). A per-device preference saved to the
// browser; the toggle applies instantly (no save), per the toggle contract.
export function AppearanceSection() {
  // Auto-open is per device on purpose: yanking navigation is fine on your own
  // laptop, hostile on a shared screen. Absent key reads as ON (no migration).
  const [autoOpen, setAutoOpen] = useState(
    () => localStorage.getItem(STORAGE_KEYS.autoOpen) !== "off",
  )
  const flipAutoOpen = (on: boolean) => {
    setAutoOpen(on)
    if (on) localStorage.removeItem(STORAGE_KEYS.autoOpen)
    else localStorage.setItem(STORAGE_KEYS.autoOpen, "off")
  }
  return (
    <SettingsSection
      title="Appearance"
      description="How Derive looks on this device. Saved to this browser."
    >
      <SettingsGroup>
        <SettingRow
          label="Theme"
          description="The light (paper) or dark (ink) canvas. Applies instantly."
        >
          <ThemeSwitch className="w-40" />
        </SettingRow>
        <SettingRow
          htmlFor="toggle-auto-open"
          label="Agent publishes open automatically"
          description="When your connected agent publishes a new draft, this tab opens it. Off keeps it to a notification."
        >
          <Switch
            id="toggle-auto-open"
            data-testid="toggle-auto-open"
            checked={autoOpen}
            onCheckedChange={flipAutoOpen}
          />
        </SettingRow>
      </SettingsGroup>
    </SettingsSection>
  )
}
