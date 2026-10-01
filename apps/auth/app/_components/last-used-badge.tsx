import { cn } from "cn"

/**
 * "Last used", on the one thing on the sign-in page that was.
 *
 * ⚠ INSIDE THE CONTROL, NOT PERCHED ON ITS BORDER. It sits in the row like a
 * label - Cloudflare's dark-navy pill with blue text, the way their account
 * picker does it, so it reads as part of the option rather than a sticker on top of it.
 *
 * ⚠ AT MOST ONE ON THE PAGE, decided by the sign-in form, not here: the saved
 * account that last signed in when we know it, otherwise the method (a
 * provider, the passkey button, or the email box for a password), otherwise
 * nothing. Two chips saying "last used" means one of them is lying.
 *
 * `pointer-events-none` so it can never eat the click meant for its control.
 */
export function LastUsedBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        // ⚠ CLOUDFLARE'S EXACT COLOURS in dark mode, sampled from their account
        // picker: #13182a fill, #65a0fd text, fully round. Light mode has no
        // reference, so it is the same blue family on a pale wash.
        "pointer-events-none inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs leading-4 font-medium",
        "bg-[#e6efff] text-[#1f5fd6] dark:bg-[#13182a] dark:text-[#65a0fd]",
        className,
      )}
    >
      Last used
    </span>
  )
}
