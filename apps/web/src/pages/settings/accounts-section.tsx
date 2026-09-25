import { useState } from "react"
import { ModelAccountPicker } from "@/components/accounts/model-account-picker"
import { ModelPlanManager } from "./model-plan-manager"
import { SettingsSection } from "./settings-section"

export function AccountsSection() {
  const [accountId, setAccountId] = useState("")
  return (
    <SettingsSection
      title="Accounts"
      description="Manage your Codex and Claude accounts in this workspace. Choose an account here or connect it while setting up a workflow."
    >
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-3">
          <h3 className="text-sm font-medium">Workflows that retain files</h3>
          <p className="text-sm text-muted-foreground">
            Sign in with your provider. You own the account; teammates can use it only through
            workflows you assign it to.
          </p>
          <ModelAccountPicker value={accountId} onChange={(account) => setAccountId(account.id)} />
        </div>
        <div className="flex flex-col gap-3 border-t pt-5">
          <h3 className="text-sm font-medium">Tasks and conversations</h3>
          <p className="text-sm text-muted-foreground">
            Existing imported logins remain available here. These uses currently require manual
            import; provider sign-in above does not replace them.
          </p>
          <ModelPlanManager scope="personal" />
        </div>
      </div>
    </SettingsSection>
  )
}
