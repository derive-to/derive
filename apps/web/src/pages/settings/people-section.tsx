import { PeopleDirectory } from "@/pages/people"
import { SettingsSection } from "./settings-section"

// People — who you work with, and who you follow. A directory is about the workspace,
// so it belongs with the workspace's other settings rather than holding a permanent
// seat in the navigation next to the product itself. The directory owns its own search
// and data; this supplies the heading.
export function PeopleSection() {
  return (
    <SettingsSection
      title="People"
      description="The people you work with, and what they’re making. Following someone surfaces their work in your library."
    >
      <PeopleDirectory />
    </SettingsSection>
  )
}
