"use client"

import { useReverification } from "@clerk/nextjs"
import { isReverificationCancelledError } from "@clerk/nextjs/errors"
import * as React from "react"
import { Button } from "@repo/ui/components/button/button"
import {
  Section,
  SectionContent,
  SectionDescription,
  SectionTitle,
} from "@repo/ui/components/i10/page"
import { stepUp } from "@/lib/actions"
import { useOpenStepUp } from "@/lib/step-up"

/**
 * Clerk's reverification modal (`<UserVerification />`, which Clerk only
 * opens through `useReverification`) beside ours, against the same API check.
 * Neither button does anything but ask "is this session fresh?" - the
 * `/console/step-up` route deletes nothing. See ../layout.tsx.
 */
/** The shape `requireFreshAuth` refuses with, so Clerk's modal opens on demand. */
const FORCED_HINT = {
  clerk_error: {
    type: "forbidden",
    reason: "reverification-error",
    metadata: { reverification: { level: "second_factor", afterMinutes: 10 } },
  },
} as const

export default function ClerkReverificationReference() {
  const open = useOpenStepUp()
  const [answer, setAnswer] = React.useState<string | null>(null)

  /** What the API says afterwards - the thing that actually decides. */
  async function apiSays(who: string, finished: boolean) {
    const result = await stepUp()
    setAnswer(
      `${who}: ${finished ? "finished" : "closed"} - API says ${result.ok ? "fresh" : "stale"}`,
    )
  }

  /*
   * ⚠ BOTH OPEN EVERY TIME, FRESH OR NOT (2026-10-12), so every method can be
   * walked on purpose. Clerk's modal is forced open by handing
   * `useReverification` a hint on the first call, whatever the session says;
   * the replay after it asks the real API.
   */
  const forced = React.useRef(true)
  const clerks = useReverification(async () => {
    if (forced.current) {
      forced.current = false
      return FORCED_HINT
    }
    return stepUp()
  })

  return (
    <Section className="pt-0">
      <SectionTitle>Clerk reference: reverification</SectionTitle>
      <SectionDescription>
        Clerk&apos;s &quot;Verification required&quot; modal and ours, both in front of
        the same harmless check. A session verified in the last ten minutes opens
        neither.
      </SectionDescription>
      <SectionContent className="flex flex-wrap items-center gap-3">
        <Button
          variant="secondary"
          onClick={async () => {
            try {
              const result = await clerks()
              setAnswer(result.ok ? "Clerk's: verified" : "Clerk's: refused")
            } catch (error) {
              setAnswer(
                isReverificationCancelledError(error)
                  ? "Clerk's: cancelled"
                  : "Clerk's: failed",
              )
            }
          }}
        >
          Open Clerk&apos;s modal
        </Button>
        <Button
          onClick={async () => {
            if (!open) return setAnswer("Ours: Clerk is not loaded")
            await apiSays("Ours", await open("second_factor"))
          }}
        >
          Open ours
        </Button>
        {answer && <p className="text-sm text-muted-foreground">{answer}</p>}
      </SectionContent>
    </Section>
  )
}
