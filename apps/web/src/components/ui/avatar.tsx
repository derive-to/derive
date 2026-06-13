import * as AvatarPrimitive from "@radix-ui/react-avatar"
import type * as React from "react"
import { cn } from "@/lib/utils"

export function Avatar({
  className,
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Root>) {
  return (
    <AvatarPrimitive.Root
      className={cn("relative flex size-7 shrink-0 overflow-hidden rounded-full", className)}
      {...props}
    />
  )
}

export function AvatarImage({
  className,
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Image>) {
  return (
    <AvatarPrimitive.Image className={cn("aspect-square size-full object-cover", className)} {...props} />
  )
}

export function AvatarFallback({
  className,
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Fallback>) {
  return (
    <AvatarPrimitive.Fallback
      className={cn(
        "flex size-full items-center justify-center rounded-full bg-accent font-mono text-2xs font-bold uppercase text-accent-foreground",
        className,
      )}
      {...props}
    />
  )
}
