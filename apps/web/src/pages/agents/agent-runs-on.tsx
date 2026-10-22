import type { AgentDetail, AgentPatch } from "@/api"
import { Field, Segmented, Sub } from "./rows"

// Whose model account and secrets an agent's tasks run on. Who may ask it is its Share
// dialog. Lending is the creator's alone to turn on; anyone managing the agent may turn it off.

export function RunsOnField({
  agent,
  edit,
  meId,
  names,
  onSave,
}: {
  agent: AgentDetail
  edit: boolean
  meId: string
  names: Map<string, string>
  onSave: (p: AgentPatch) => void
}) {
  const creator = agent.created_by
  const mine = !!creator && creator === meId
  const creatorName = (creator && names.get(creator)) || "its creator"
  const lends = agent.spend_policy === "creator"
  return (
    <Field label="Runs on">
      <Segmented
        testId="agent-spend-policy"
        value={agent.spend_policy}
        disabled={!edit || (!mine && !lends)}
        onChange={(v) => onSave({ spend_policy: v as AgentDetail["spend_policy"] })}
        options={[
          { value: "asker", label: "Each asker’s account" },
          {
            value: "creator",
            label: mine ? "My account" : `${creatorName}’s account`,
            disabled: !mine,
          },
        ]}
      />
      <Sub>
        {lends
          ? `Every task runs on ${mine ? "your" : `${creatorName}’s`} model account and the secrets bound here. Askers never see the values, but the agent’s commands can use them.`
          : "Each person’s tasks run on their own model account, with only their own or the workspace’s secrets."}
      </Sub>
      {lends && !mine && edit && (
        <Sub>Only {creatorName} can change this agent while it runs on their account.</Sub>
      )}
    </Field>
  )
}
