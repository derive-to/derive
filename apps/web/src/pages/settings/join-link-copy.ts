import type { BillingInfo, Role } from "@/api"
import { unitPrice } from "./billing-plans"

/** The slice of BillingInfo the copy depends on. `undefined` = not loaded yet. */
export type JoinLinkBilling =
  | Pick<BillingInfo, "tier" | "interval" | "subscribed" | "beta">
  | undefined

// The per-editor monthly price this workspace pays, or would pay: the live plan's unit when
// subscribed, else Team monthly (the plan a 4th Creator moves a free workspace onto).
const price = (b: JoinLinkBilling): string =>
  `$${b?.subscribed ? unitPrice(b.tier, b.interval) : unitPrice("team", "month")}/mo`

/** The always-visible line under the role select (and beside a live Creator link) that states
 *  what a Creator costs. Null for a Viewer link: viewers never hold a seat. Billing is
 *  licensed on grant, so once on Team EVERY Creator and Admin bills, not only the ones past
 *  three; the Team line says so, the free line says what the 4th Creator does. */
export function joinLinkSeatLine(billing: JoinLinkBilling, role: Role): string | null {
  if (role !== "editor" && role !== "owner") return null
  if (billing?.beta) return "Billing is off on this instance, so Creators stay free."
  if (billing?.subscribed)
    return `Every Creator and Admin is ${price(billing)}. Each join adds one.`
  return `Free covers 3 Creators. A 4th moves you to Team, where every Creator and Admin is ${price(billing)}.`
}

/** Under a live Creator link. */
export const joinLinkActiveLine = (billing: JoinLinkBilling): string =>
  `Each join adds a Creator at ${price(billing)}.`

/** The seat-confirm dialog a subscribed workspace sees before a Creator link exists. */
export const joinLinkConfirmTitle = "Create a Creator link?"
export const joinLinkConfirmDescription = (billing: JoinLinkBilling, workspace: string): string =>
  `Everyone who joins becomes a Creator and adds ${price(billing)} to ${workspace}'s bill. Revoke the link any time.`
