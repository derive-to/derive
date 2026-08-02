import { useQuery } from "@tanstack/react-query"
import { useAuth } from "@/ctx"
import { workspaceSettingsQuery } from "./queries"

/**
 * IS THE AGENT AVAILABLE HERE — the one answer four surfaces need.
 *
 * The rail row, the palette's Ask, the home and search buttons and the dock all have to hide
 * themselves in a workspace that turned chat off, and each of them reading the settings query and
 * re-deriving the rule is how four surfaces end up disagreeing: an offered control that leads to
 * a wall, or a hidden one in a workspace where chat works fine.
 *
 * TRUE WHILE UNRESOLVED, deliberately. Chat is on by default, so treating "not loaded yet" as off
 * would blink every ask affordance out of existence on each cold boot and back a moment later.
 * The settings read rides the boot batch the shell already makes, so this costs no request.
 */
export function useChatEnabled(): boolean {
  const { me } = useAuth()
  const { data } = useQuery({ ...workspaceSettingsQuery(), staleTime: 60_000, enabled: !!me })
  return data ? data.chatBeta === true : true
}
