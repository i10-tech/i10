"use client"

import * as React from "react"
import { toast } from "sonner"
import { Button } from "@repo/ui/components/button"
import { Spinner } from "@repo/ui/components/spinner"
import { cn } from "cn"
import { ProviderMark } from "@/components/provider-mark"
import { startDnsConnect } from "@/lib/actions"

/**
 * "Connect my DNS provider."
 *
 * ⚠ IT NAVIGATES RATHER THAN OPENING A POPUP. Several providers refuse to render
 * their authorisation screen inside a frame, and a popup is blocked by default
 * on a click that has been through an async round trip. A full navigation is the
 * flow every OAuth integration used before anybody tried to be clever, and the
 * callback page brings them back.
 *
 * ⚠ IT LIVES IN ITS OWN FILE BECAUSE THREE SURFACES NEED IT. The domain page
 * offers it beside "publish these for me"; the add-domain form offers it while
 * somebody is still choosing how to set the domain up; onboarding offers it as
 * the whole of a step. One copy, so they cannot drift into saying different
 * things about the same capability.
 *
 * ⚠ AND IT IS THE SAME SHAPE AS THE SIGN-IN PAGE'S PROVIDER BUTTONS — a pill,
 * the provider's mark on the left, "Continue with…" wording. Somebody who
 * signed in with Google pressed this exact control twenty minutes ago, and the
 * step that asks them to authorise something is the wrong place to be
 * inventive.
 */
export function ConnectProviderButton({
  slug,
  providerName,
  returnTo,
  label,
  variant = "outline",
  size = "sm",
  block,
  brand,
  className,
}: {
  slug: string
  providerName: string
  /**
   * Where to come back to once the provider is done.
   *
   * ⚠ ONBOARDING WAS LOSING PEOPLE WITHOUT IT. The callback lands inside the
   * console shell, so somebody who pressed this half-way through the setup
   * flow came back to a page that knew nothing about it — the connection was
   * made and the flow was gone. Every caller that is somewhere worth returning
   * to passes its own path.
   */
  returnTo?: string
  /** Overrides the default "Connect X" wording. */
  label?: string
  /** Full width, for a step whose whole content is this one action. */
  block?: boolean
  /**
   * The provider-button look: a white pill carrying their mark in their colour.
   *
   * ⚠ THE SAME SHAPE EVERY "SIGN IN WITH…" BUTTON ON THE WEB USES, and that is
   * the entire argument for it. This is the one control in the product that
   * sends somebody to a third party and asks them to trust us there; making it
   * look like the control they have pressed on twenty other sites is worth more
   * than making it match the surrounding monochrome.
   *
   * ⚠ WHITE IN BOTH THEMES, WITH A BORDER SO IT SURVIVES THE LIGHT ONE. A
   * background that followed the theme would put a dark mark on a dark pill for
   * half our users, and brand marks are drawn for light backgrounds.
   */
  brand?: boolean
  className?: string
  variant?: React.ComponentProps<typeof Button>["variant"]
  size?: React.ComponentProps<typeof Button>["size"]
}) {
  const [pending, setPending] = React.useState(false)

  async function connect() {
    setPending(true)
    const result = await startDnsConnect(slug, returnTo)

    if (!result.ok) {
      /*
       * ⚠ PENDING IS CLEARED ONLY HERE, ON THE PATH THAT STAYS ON THIS PAGE.
       * It used to be cleared the moment the action returned, which meant the
       * button went back to being pressable a beat BEFORE the browser started
       * leaving — so the last thing somebody saw was a live button that had
       * apparently done nothing, and the honest response to that is to press it
       * again. The navigation below is not instant: it is a full document load
       * of somebody else's domain, and the spinner has to cover all of it.
       */
      setPending(false)
      /*
       * ⚠ THE DEPLOYMENT'S OWN MISCONFIGURATION READS DIFFERENTLY FROM A
       * FAILURE. An OAuth app that has not been registered answers "not
       * configured on this deployment", which is not something the customer can
       * fix and will never clear on its own — so it must not be phrased as
       * "try again".
       */
      toast.error(`Could not connect ${providerName}`, { description: result.error })
      return
    }

    window.location.assign(result.data.url)
  }

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      onClick={connect}
      disabled={pending}
      className={cn(
        block && "w-full",
        brand && [
          /*
           * ⚠ THE `dark:` COUNTERPARTS ARE NOT OPTIONAL HERE, AND LEAVING THEM
           * OFF PRODUCED A BUTTON WITH NO VISIBLE LABEL. The `outline` variant
           * carries `dark:bg-input/30`, and tailwind-merge treats a prefixed
           * utility as a DIFFERENT key from its unprefixed form — so `bg-white`
           * did not replace it, the pill stayed dark, and `text-neutral-950`
           * applied on top of it.
           */
          "border-neutral-200 bg-white text-neutral-950",
          "hover:bg-neutral-100 hover:text-neutral-950",
          "dark:border-neutral-200 dark:bg-white dark:hover:bg-neutral-100",
        ],
        className,
      )}
    >
      {pending ? <Spinner /> : <ProviderMark slug={slug} name={providerName} />}
      {label ?? `Connect ${providerName}`}
    </Button>
  )
}
