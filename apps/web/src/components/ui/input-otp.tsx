import { OTPInput, OTPInputContext, REGEXP_ONLY_DIGITS } from "input-otp"
import type * as React from "react"
import { useContext } from "react"
import { cn } from "@/lib/utils"

export { REGEXP_ONLY_DIGITS }

// Segmented one-time-code input (shadcn's input-otp, styled to Derive's tokens). One box per
// digit, auto-advancing, paste-aware. Used for the 6-digit TOTP in 2FA setup and login.
function InputOTP({
  className,
  containerClassName,
  ...props
}: React.ComponentProps<typeof OTPInput> & { containerClassName?: string }) {
  return (
    <OTPInput
      data-slot="input-otp"
      containerClassName={cn("flex items-center gap-2 has-disabled:opacity-50", containerClassName)}
      className={cn("disabled:cursor-not-allowed", className)}
      {...props}
    />
  )
}

function InputOTPGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="input-otp-group"
      className={cn("flex items-center gap-1.5", className)}
      {...props}
    />
  )
}

function InputOTPSlot({
  index,
  className,
  ...props
}: React.ComponentProps<"div"> & { index: number }) {
  const context = useContext(OTPInputContext)
  const { char, isActive } = context.slots[index] ?? {}
  return (
    <div
      data-slot="input-otp-slot"
      data-active={isActive}
      className={cn(
        // The Input primitive's quiet well + focus grammar, sized as a single-digit box.
        "flex h-11 w-9 items-center justify-center rounded-lg border border-input bg-transparent text-base font-medium tabular-nums shadow-(--shadow-sm) transition-[color,box-shadow] dark:bg-input/30 sm:text-sm",
        "data-[active=true]:z-10 data-[active=true]:border-ring data-[active=true]:ring-2 data-[active=true]:ring-ring/40",
        className,
      )}
      {...props}
    >
      {char}
    </div>
  )
}

export { InputOTP, InputOTPGroup, InputOTPSlot }
