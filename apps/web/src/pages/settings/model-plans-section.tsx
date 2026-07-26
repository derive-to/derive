import { ModelPlanManager } from "./model-plan-manager"
import { SettingsSection } from "./settings-section"

// Personal "Model plans": connect your OWN Claude/Codex plan (or API key). It is encrypted
// and used ONLY for runs YOU initiate — never shared. This is what lets your work run on
// hosted Derive without a machine of your own. (The workspace-shared pool and per-agent
// owner-lend live in the Agents section.)
export function ModelPlansSection() {
  return (
    <SettingsSection
      title="Model plans"
      description={
        <>
          Connect your own model plan so your agents run on it. Your token is encrypted and used
          only for runs you start, never shared with anyone else on the team.
        </>
      }
    >
      <ModelPlanManager scope="personal" />
    </SettingsSection>
  )
}
