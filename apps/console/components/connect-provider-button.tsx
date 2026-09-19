"use client"

import * as React from "react"
import { Plug } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@repo/ui/components/button"
import { Spinner } from "@repo/ui/components/spinner"
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
 * ⚠ IT LIVES IN ITS OWN FILE BECAUSE TWO SURFACES NEED IT. The domain page
 * offers it beside "publish these for me"; the add-domain form offers it while
 * somebody is still choosing how to set the domain up, which is the moment they
 * are actually deciding. One copy, so the two cannot drift into saying different
 * things about the same capability.
 */
export function ConnectProviderButton({
  slug,
  providerName,
  label,
  variant = "outline",
  size = "sm",
}: {
  slug: string
  providerName: string
  /** Overrides the default "Connect X" wording. */
  label?: string
  variant?: React.ComponentProps<typeof Button>["variant"]
  size?: React.ComponentProps<typeof Button>["size"]
}) {
  const [pending, setPending] = React.useState(false)

  async function connect() {
    setPending(true)
    const result = await startDnsConnect(slug)
    setPending(false)

    if (!result.ok) {
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
    >
      {pending ? <Spinner /> : <Plug />}
      {label ?? `Connect ${providerName}`}
    </Button>
  )
}
