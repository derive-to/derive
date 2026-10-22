import type { AgentDetail, AgentPatch } from "@/api"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Field, Segmented, Sub, Verb } from "./rows"

// Who may ask an agent, and whose model account and secrets their tasks run on. Lending is the
// creator's alone to turn on; anyone managing the agent may turn it off.

export function AccessFields({
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
  const nameOf = (id: string) => names.get(id) || "A former member"
  const addable = [...names.keys()].filter((id) => id !== creator && !agent.askers.includes(id))
  return (
    <>
      <Field label="Access">
        <Segmented
          testId="agent-ask-policy"
          value={agent.ask_policy}
          disabled={!edit}
          onChange={(v) => onSave({ ask_policy: v as AgentDetail["ask_policy"] })}
          options={[
            { value: "workspace", label: "Workspace" },
            { value: "invited", label: "Chosen people" },
          ]}
        />
        <Sub>
          {agent.ask_policy === "workspace"
            ? "Every member can ask it for work."
            : "Its creator, the workspace owners and the people below can ask it for work."}
        </Sub>
      </Field>
      {agent.ask_policy === "invited" && (
        <Field label="People">
          <div data-testid="agent-askers" className="flex flex-col gap-1">
            {agent.askers.length === 0 && <span className="text-muted-foreground">Nobody yet</span>}
            {agent.askers.map((id) => (
              <span key={id} className="flex items-center justify-between gap-3">
                <span className="truncate">{nameOf(id)}</span>
                {edit && (
                  <Verb
                    testId={`agent-asker-remove-${id}`}
                    onClick={() => onSave({ askers: agent.askers.filter((a) => a !== id) })}
                  >
                    Remove
                  </Verb>
                )}
              </span>
            ))}
          </div>
          {edit && addable.length > 0 && (
            <Select value="" onValueChange={(id) => onSave({ askers: [...agent.askers, id] })}>
              <SelectTrigger
                data-testid="agent-asker-add"
                aria-label="Add a person"
                className="w-56"
              >
                <SelectValue placeholder="Add a person" />
              </SelectTrigger>
              <SelectContent>
                {addable.map((id) => (
                  <SelectItem key={id} value={id}>
                    {nameOf(id)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </Field>
      )}
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
    </>
  )
}
