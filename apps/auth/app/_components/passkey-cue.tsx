"use client"

import { useSyncExternalStore } from "react"
import { NEUTRAL_ENVIRONMENT, passkeyEnvironment } from "../_lib/platform"

/**
 * A hint behind the operating system's passkey dialog.
 *
 * ⚠ IT USED TO LIVE ON A PAGE OF ITS OWN AND NOW IT DOES NOT, WHICH IS THE
 * WHOLE REASON IT IS A COMPONENT. `/passkey` was a screen whose only content
 * was a heading and a button that opened this prompt — a navigation, a render
 * and a second decision in front of something that is one tap. The button moved
 * onto the sign-in page; this overlay is the part that was actually doing work
 * and it came with it.
 *
 * ⚠ IT CANNOT KNOW WHERE THAT DIALOG ACTUALLY IS, AND IT DOES NOT PRETEND TO.
 * The WebAuthn prompt is drawn by the browser or the OS, outside the page and
 * outside anything script can measure — macOS Safari puts it under the toolbar,
 * Chrome centres its own sheet, Windows throws a full system modal, and a phone
 * slides one up from the bottom. So the dashed frame below is CENTRED AND
 * GENEROUS: a place to look, not a border traced around a real window. Anything
 * that claimed to be exact would be wrong on most machines and would look
 * broken rather than helpful.
 */
export function PasskeyCue() {
  /**
   * ⚠ `useSyncExternalStore`, NOT AN EFFECT THAT SETS STATE. `passkeyEnvironment`
   * reads `navigator`, which does not exist on the server — calling it during
   * render would produce markup disagreeing with the client and get thrown away
   * as a hydration mismatch. This hook exists for exactly this shape: a server
   * snapshot, a client snapshot, and React reconciling the two itself. The
   * subscribe function is a no-op because a platform does not change mid-visit.
   */
  const env = useSyncExternalStore(
    () => () => {},
    passkeyEnvironment,
    () => NEUTRAL_ENVIRONMENT,
  )

  const align =
    env.placement === "top"
      ? "justify-start pt-16"
      : env.placement === "bottom"
        ? "justify-end pb-16"
        : "justify-center"

  return (
    <div
      // ⚠ NOT `aria-hidden` ON THE WHOLE THING, AND NOT `role="dialog"` EITHER.
      // Hiding it all would hide the one sentence this exists to say; claiming
      // to be a dialog would fight the real one, which belongs to the OS and
      // already owns focus. The message is a polite live region and only the
      // dashed frame is hidden, because a rectangle read aloud is noise.
      //
      // ⚠ AND IT IS `pointer-events-none`. The real dialog is modal and sits
      // above this; an overlay that swallowed clicks would only eat the first
      // click after somebody cancels.
      className={`pointer-events-none fixed inset-0 z-50 flex flex-col items-center gap-6 bg-background/80 px-6 backdrop-blur-sm ${align}`}
    >
      <p role="status" className="text-center text-sm font-medium">
        Authenticate your passkey below
      </p>
      <div
        aria-hidden="true"
        className="flex h-52 w-full max-w-sm items-center justify-center rounded-xl border-2 border-dashed border-muted-foreground/40"
      >
        <p className="px-6 text-center text-xs text-balance text-muted-foreground">
          {env.hint}
        </p>
      </div>
    </div>
  )
}
