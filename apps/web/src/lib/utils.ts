import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

/** Merge conditional class lists and de-dupe conflicting Tailwind utilities. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
