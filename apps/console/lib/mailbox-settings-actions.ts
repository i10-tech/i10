"use server"

import { revalidatePath } from "next/cache"
import { api } from "@/lib/api"
import {
  forgetHiddenEmailSetup,
  rememberHiddenEmailSetup,
} from "@/lib/email-setup-hidden"
import type { CreationMode } from "@/lib/mailbox-settings"
import { run } from "@/lib/sso-run"

/**
 * What the Mailboxes page's setup card and settings page write (U0), as server
 * actions for the reason lib/actions.ts gives: the session token stays on the
 * server, and a refusal comes back as a value carrying the API's own words.
 */

/**
 * Changes who creates mailboxes.
 *
 * ⚠ THE STEP-UP IS ASKED BY THE CALLER FIRST. The API refuses a stale session
 * with Clerk's hint (`PUT /console/mailboxes/creation-mode`), and the dialog that
 * answers it lives in the browser. The role check is the API's: a member never
 * sees the control, and would be refused here if they sent the request by hand.
 */
export async function setCreationMode(mode: CreationMode) {
  return run(async () => {
    const answer = await api<{ mode: CreationMode }>(
      "/console/mailboxes/creation-mode",
      {
        method: "PUT",
        body: { mode },
      },
    )
    // ⚠ THE MAILBOXES PAGE READS IT TO DECIDE WHETHER A MEMBER SEES A CREATE BUTTON.
    revalidatePath("/mailboxes", "page")
    return answer
  })
}

/** Hides the setup card until the browser is closed. */
export async function hideEmailSetup(tenantId: string): Promise<void> {
  await rememberHiddenEmailSetup(tenantId)
  revalidatePath("/mailboxes", "page")
}

/** Brings the setup card back. */
export async function showEmailSetup(): Promise<void> {
  await forgetHiddenEmailSetup()
  revalidatePath("/mailboxes", "page")
}
