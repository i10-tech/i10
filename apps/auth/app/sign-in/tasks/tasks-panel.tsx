"use client"

import { useEffect } from "react"
import {
  TaskChooseOrganization,
  TaskResetPassword,
  TaskSetupMFA,
  useSession,
} from "@clerk/nextjs"
import { Spinner } from "@repo/ui/components/spinner"

/**
 * Whichever step Clerk is holding this session on.
 *
 * ⚠ IT SWITCHES ON `session.currentTask.key` RATHER THAN RENDERING ONE
 * COMPONENT, because a session can owe more than one thing and Clerk resolves
 * them in order — finishing `choose-organization` leaves the session pending on
 * `setup-mfa`, still on this URL. Each component re-reads the session when it
 * completes, so the switch simply renders the next one; hard-coding
 * `TaskChooseOrganization` would leave the second task with nowhere to go.
 *
 * ⚠ AND EVERY BRANCH GETS THE SAME `redirectUrlComplete`. That prop fires only
 * once ALL tasks are resolved, not after each one — see its type in
 * `@clerk/shared`: "Full URL or path to navigate to after successfully resolving
 * all tasks". So passing the final destination to each of them is correct, and
 * passing this page's own URL would be an infinite loop.
 */
export function TasksPanel({ afterAuthUrl }: { afterAuthUrl: string }) {
  const { isLoaded, session } = useSession()
  const task = session?.currentTask

  /**
   * ⚠ NO TASK MEANS THE PERSON SHOULD NOT BE HERE, AND LEAVING IS THE ONLY
   * CORRECT ANSWER. Two ways to arrive in that state: the session went active
   * between the middleware's redirect and this render — a race that is normal
   * rather than exceptional, because resolving the last task is what makes it
   * active — or somebody typed the URL. Rendering "nothing to do" for the first
   * case would strand a signed-in person one click from where they were going.
   *
   * ⚠ `window.location`, NOT `router.push`. The destination is a different
   * origin (the console), which the Next router cannot navigate to.
   */
  useEffect(() => {
    if (!isLoaded) return
    if (task) return
    window.location.replace(afterAuthUrl)
  }, [isLoaded, task, afterAuthUrl])

  if (!isLoaded || !task) {
    return (
      <div
        className="flex min-h-40 items-center justify-center"
        // ⚠ THE SPINNER CARRIES THE LABEL BECAUSE THERE IS NO OTHER TEXT. On
        // every other screen a heading says what is happening; here the whole
        // panel is a wait, so a bare spinner would announce nothing at all.
        aria-live="polite"
      >
        <Spinner aria-label="Finishing sign-in" />
      </div>
    )
  }

  switch (task.key) {
    case "choose-organization":
      return <TaskChooseOrganization redirectUrlComplete={afterAuthUrl} />
    case "reset-password":
      return <TaskResetPassword redirectUrlComplete={afterAuthUrl} />
    case "setup-mfa":
      return <TaskSetupMFA redirectUrlComplete={afterAuthUrl} />
    default:
      /*
       * ⚠ AN UNKNOWN TASK IS A CLERK UPGRADE, NOT A BUG IN THIS FILE, AND IT
       * MUST NOT RENDER AN EMPTY BOX. `SessionTask["key"]` is a union Clerk is
       * free to extend in a minor release; when it does, this branch is what
       * somebody sees. Naming the key is what turns a blank screen into a
       * support ticket that can be answered.
       */
      return (
        <div className="space-y-2 text-center">
          <h1 className="text-lg font-semibold tracking-tight">
            This account needs a step we do not support yet
          </h1>
          <p className="text-sm text-muted-foreground">
            Contact support and quote <code className="font-mono">{task.key}</code>.
          </p>
        </div>
      )
  }
}
