// THE ONE READ of the workspace's agent-write switch, for every surface that acts on it.
//
// The switch is a permission with I/O behind it, so it cannot live in core's pure `can()`
// — but its POLICY must not be re-implemented per surface: fail CLOSED (an unreadable
// switch reads as OFF, because a brake an error can defeat is not a brake), and refuse in
// one voice. A surface that forgets to call this is one grep away from being found;
// a surface with its own hand-rolled read is how a bypass hides.

import type { MetaStore } from "@derive/core"

/** Is the workspace's agent-write switch OFF (or unreadable — same answer)? */
export const agentWritesOff = async (meta: MetaStore, orgId: string): Promise<boolean> =>
  !(await meta
    .getOrgSettings(orgId)
    .then((s) => s.agentWrites)
    .catch(() => false))

/** The refusal, worded once: what happened, and where the drafted work goes instead. */
export const AGENT_WRITES_OFF =
  "This workspace has agent writes switched off, so publishing is refused. Put the change you drafted in your reply instead, as a suggestion for the person to apply."
