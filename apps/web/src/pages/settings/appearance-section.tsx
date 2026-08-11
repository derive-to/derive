import { ThemeSwitch } from "@/components/chrome/theme-switch"
import { SettingRow } from "@/components/shared/setting-row"
import { SettingsGroup } from "@/components/shared/settings-group"
import { SettingsSection } from "./settings-section"

// Personal appearance — theme lives here as its source-of-truth control (a quick
// toggle also rides the account pod). A per-device preference saved to the
// browser; the switch applies instantly (no save), per the toggle contract.
export function AppearanceSection() {
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
      </SettingsGroup>
    </SettingsSection>
  )
}
