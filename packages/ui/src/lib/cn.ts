import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

/** The shadcn class merge helper. Every generated component imports it. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
