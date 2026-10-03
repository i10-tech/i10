"use client"

import { useSyncExternalStore } from "react"
import { Spinner } from "@repo/ui/components/spinner"
import {
  NEUTRAL_ENVIRONMENT,
  passkeyEnvironment,
  type Biometric,
} from "../_lib/platform"
import {
  AndroidFingerprintIcon,
  FaceIdIcon,
  PasskeyIcon,
  TouchIdIcon,
  WindowsHelloIcon,
} from "./provider-icons"

/**
 * The screen behind the operating system's passkey prompt.
 *
 * ⚠ IT USED TO LIVE ON A PAGE OF ITS OWN AND NOW IT DOES NOT, WHICH IS THE
 * WHOLE REASON IT IS A COMPONENT. `/passkey` was a screen whose only content
 * was a heading and a button that opened this prompt - a navigation, a render
 * and a second decision in front of something that is one tap. The button moved
 * onto the sign-in page; this overlay is the part that was actually doing work
 * and it came with it.
 *
 * ⚠ A SOLID SCREEN, NOT A BLUR. It used to be the form under an 80% veil with
 * a backdrop blur, which read as the page breaking rather than as a step: a
 * smeared copy of the form, still recognisable, with a sentence floating over
 * it. Now the form is simply replaced while the prompt is open, and comes back
 * when it closes.
 *
 * ⚠ IT CANNOT KNOW WHERE THE PROMPT ACTUALLY IS, AND IT DOES NOT PRETEND TO.
 * The WebAuthn dialog is drawn by the browser or the OS, outside the page and
 * outside anything script can measure. The hint names the usual place for this
 * platform - see _lib/platform.ts - and the content is placed on the far side
 * of the screen from it.
 *
 * ⚠ THE ICON IS A GUESS AT THE SENSOR, NOT A CLAIM. Each platform gets its
 * own glyph - see `Biometric` in _lib/platform.ts - and Apple's only ever
 * appear on Apple devices. A passkey on a security key or another phone works
 * the same whatever is drawn; the icon only says "this is the biometric step".
 */
export function PasskeyCue({
  mode = "use",
}: {
  /** Signing in with a passkey, or saving a new one during sign-up. */
  mode?: "use" | "create"
} = {}) {
  /**
   * ⚠ `useSyncExternalStore`, NOT AN EFFECT THAT SETS STATE. `passkeyEnvironment`
   * reads `navigator`, which does not exist on the server - calling it during
   * render would produce markup disagreeing with the client and get thrown away
   * as a hydration mismatch. The subscribe function is a no-op because a
   * platform does not change mid-visit.
   */
  const env = useSyncExternalStore(
    () => () => {},
    passkeyEnvironment,
    () => NEUTRAL_ENVIRONMENT,
  )
  const Icon = ICONS[env.biometric]
  const phone = env.placement === "bottom"

  /*
   * ⚠ NEVER WHERE THE PROMPT IS. On a laptop every prompt lives in the top two
   * thirds of the window: Chrome's own dialog hangs from the toolbar (the QR
   * code reaches about 60% down), the macOS Passwords sheet sits in the middle
   * (to about 70%), Safari's hangs from the address bar, and Windows centres
   * its own. Centred text sat under all of them, so it goes to the bottom. A
   * phone is the reverse - its sheet rises from the bottom - so there it goes
   * to the top, the same distance from that edge - a mirror image.
   *
   * ⚠ AND ON A LAPTOP IT IS A ROW, NOT A STACK. Stacked, the block was about
   * 260px tall and its top - the icon - ran up under the macOS sheet on any
   * window shorter than a full screen. Icon beside the text is half the height
   * and fits in the strip the prompts leave free.
   */
  const align = phone
    ? "justify-start pt-[calc(7vh+env(safe-area-inset-top))]"
    : "justify-end pb-[calc(11vh+env(safe-area-inset-bottom))]"

  return (
    <div
      // ⚠ NOT `role="dialog"`, AND `pointer-events-none`. The real dialog
      // belongs to the OS and already owns focus; claiming to be one would
      // fight it, and swallowing clicks would only eat the first click after
      // somebody cancels. The heading and hint are a polite live region.
      className={`pointer-events-none fixed inset-0 z-50 flex flex-col items-center bg-background px-6 ${align}`}
      style={{ animation: "surface-enter var(--duration-base) var(--ease-quint-out)" }}
    >
      <div
        role="status"
        className={
          phone
            ? "flex w-full max-w-sm flex-col items-center gap-6 text-center"
            : "flex max-w-xl items-center gap-5 text-left"
        }
        style={{
          ["--surface-y" as string]: "8px",
          animation: "surface-enter var(--duration-slow) var(--ease-quint-out)",
        }}
      >
        <div
          aria-hidden="true"
          className="relative grid size-20 shrink-0 place-items-center"
        >
          {[0, 1].map((ring) => (
            <span
              key={ring}
              className="passkey-tile absolute inset-0 border border-foreground/20"
              style={{
                animation: `passkey-ring 2.4s var(--ease-quint-out) ${ring * 1.2}s infinite both`,
              }}
            />
          ))}
          {/*
           * ⚠ BUILT LIKE AN APP ICON, NOT A CARD. A gradient lit from above
           * (lighter at the top), a hairline edge, a one-pixel highlight along
           * the top inside edge where the light would catch, and a soft shadow
           * under it - the four things that make a flat square read as an
           * object. The shape is a squircle where the browser can draw one;
           * see `.passkey-tile` in globals.css.
           */}
          <span className="passkey-tile relative grid size-20 place-items-center bg-linear-to-b from-foreground/[0.11] to-foreground/[0.03] shadow-[inset_0_1px_0_0_rgb(255_255_255/0.12),0_10px_30px_-10px_rgb(0_0_0/0.7)] ring-1 ring-foreground/10 ring-inset">
            <Icon className="size-10 text-foreground/90" />
          </span>
        </div>

        <div
          className={phone ? "flex flex-col items-center gap-6" : "flex flex-col gap-2"}
        >
          <div className={phone ? "flex flex-col gap-2" : "flex flex-col gap-1"}>
            <h1 className={phone ? "text-2xl font-bold" : "text-xl font-bold"}>
              {mode === "create" ? "Save your passkey" : "Authenticate your passkey"}
            </h1>
            <p className="text-sm text-balance text-muted-foreground">{env.hint}</p>
          </div>

          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner aria-hidden="true" aria-label={undefined} className="size-3.5" />
            Waiting for your device…
          </p>
        </div>
      </div>
    </div>
  )
}

const ICONS: Record<
  Biometric,
  (props: React.ComponentProps<"svg">) => React.ReactNode
> = {
  "face-id": FaceIdIcon,
  "touch-id": TouchIdIcon,
  android: AndroidFingerprintIcon,
  windows: WindowsHelloIcon,
  passkey: PasskeyIcon,
}
