import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"

// The leading tile of a connected account's row in Settings › Sources (a GitHub organization, a
// Slack workspace): its picture when there is one, otherwise its first letter. Rounded square,
// not a circle, because these are organizations rather than people. Sized for ListRow's
// stackActions indent.
export function AccountMark({ name, src }: { name: string; src?: string | null }) {
  return (
    <Avatar className="size-7 rounded-md">
      {src && <AvatarImage className="rounded-md" src={src} alt="" />}
      <AvatarFallback className="rounded-md text-xs">
        {name.slice(0, 1).toUpperCase()}
      </AvatarFallback>
    </Avatar>
  )
}
