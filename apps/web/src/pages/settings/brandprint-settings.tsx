import { BrandprintBody } from "@/pages/brandprint"
import { SettingsSection } from "./settings-section"

// Brandprint — the workspace's conventions, and your personal layer over them. It had
// its own rail row; it's configuration a team sets up and returns to occasionally,
// which is what Settings is for, and a permanent nav row is an expensive way to teach
// something once. The label stays "Brandprint" everywhere: every entry point that sends
// you here says that word, and the agent-facing URIs are derive://brandprint/*.
export function BrandprintSettings() {
  return (
    <SettingsSection
      title="Brandprint"
      description="Design and writing guidance for this workspace. Connected coding agents read it automatically."
    >
      <BrandprintBody />
    </SettingsSection>
  )
}
