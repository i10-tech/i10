"use client"

import * as React from "react"
import { Button } from "@repo/ui/components/button/button"
import { cn } from "cn"
import { ProviderMark } from "@/components/provider-mark"
import { startDnsConnect } from "@/lib/actions"
import { toastError } from "@/lib/toast"

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
 * ⚠ AND IT IS THE SAME SHAPE AS THE SIGN-IN PAGE'S PROVIDER BUTTONS - a pill,
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
  variant = "secondary",
  size = "sm",
  block,
  className,
}: {
  slug: string
  providerName: string
  /**
   * Where to come back to once the provider is done.
   *
   * ⚠ ONBOARDING WAS LOSING PEOPLE WITHOUT IT. The callback lands inside the
   * console shell, so somebody who pressed this half-way through the setup
   * flow came back to a page that knew nothing about it - the connection was
   * made and the flow was gone. Every caller that is somewhere worth returning
   * to passes its own path.
   */
  returnTo?: string
  /** Overrides the default "Connect X" wording. */
  label?: string
  /** Full width, for a step whose whole content is this one action. */
  block?: boolean
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
       * leaving - so the last thing somebody saw was a live button that had
       * apparently done nothing, and the honest response to that is to press it
       * again. The navigation below is not instant: it is a full document load
       * of somebody else's domain, and the spinner has to cover all of it.
       */
      setPending(false)
      /*
       * ⚠ THE DEPLOYMENT'S OWN MISCONFIGURATION READS DIFFERENTLY FROM A
       * FAILURE. An OAuth app that has not been registered answers "not
       * configured on this deployment", which is not something the customer can
       * fix and will never clear on its own - so it must not be phrased as
       * "try again".
       */
      toastError(`Could not connect ${providerName}`, { description: result.error })
      return
    }

    window.location.assign(result.data.url)
  }

  return (
    <Button
      loading={pending}
      type="button"
      variant={variant}
      size={size}
      onClick={connect}
      disabled={pending}
      className={cn(block && "w-full", className)}
    >
      <ProviderMark slug={slug} name={providerName} />
      {label ?? `Connect ${providerName}`}
    </Button>
  )
}
