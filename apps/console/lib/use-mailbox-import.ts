"use client"

import * as React from "react"
import {
  reserveMailboxImport,
  startMailboxImport,
} from "@/lib/mailbox-transfer-actions"
import {
  nextImportStep,
  type ImportFlow,
  transferRefusal,
  uploadFailureWords,
  type ImportStep,
  type MailboxJob,
  type Reservation,
} from "@/lib/mailbox-transfer"
import { putArchive, UploadError } from "@/lib/mailbox-upload"
import { useStepUp } from "@/lib/step-up"
import { toastDone } from "@/lib/toast"

/**
 * The three steps of an import, in order, for one mailbox: reserve a place in
 * storage (behind step-up), send the file there from the browser, then say it
 * has arrived. What each step may repeat after a failure is
 * `nextImportStep`'s decision; this holds the state it decides over.
 *
 * ⚠ THE FLOW OUTLIVES THE DIALOG THAT STARTED IT. A gigabyte archive takes
 * longer than anybody keeps a dialog open, so the dialog only asks for the
 * reservation (and shows its refusal); the upload and the start then run here and
 * are shown on the page's own card, where closing the dialog cannot lose them.
 *
 * ⚠ THE FILE, THE RESERVATION AND THE ABORT HANDLE ARE REFS, NOT STATE. None of
 * them is drawn: only `flow` is, and a re-render must never be able to replace
 * the `File` that a retry is about to send.
 *
 * ⚠ LEAVING THE PAGE ENDS THE UPLOAD, and says so first: a close or reload asks
 * (`beforeunload`), and moving to another page of the console aborts the request
 * on unmount. The reservation stays on the server as an import whose file never
 * arrived, which the page shows as that when it is opened again.
 */

const IDLE: ImportFlow = { phase: "idle" }

/** How the reservation went, for the dialog that asked for it. */
export type BeginResult =
  { kind: "reserved" } | { kind: "declined" } | { kind: "refused"; message: string }

/** Progress is drawn a few times a second: the browser reports it far more often. */
const PROGRESS_EVERY_MS = 250

export function useMailboxImport({
  address,
  current,
  setJob,
}: {
  address: string
  /** The import job the page shows now, to put back when an upload is cancelled. */
  current: MailboxJob | null
  setJob: (job: MailboxJob | null) => void
}) {
  const stepUp = useStepUp()
  const [flow, setFlow] = React.useState<ImportFlow>(IDLE)

  const file = React.useRef<File | undefined>(undefined)
  const reservation = React.useRef<Reservation | undefined>(undefined)
  const abort = React.useRef<AbortController | undefined>(undefined)
  const before = React.useRef<MailboxJob | null>(null)
  const latest = React.useRef(current)
  React.useEffect(() => {
    latest.current = current
  })

  const uploading = flow.phase === "uploading" || flow.phase === "starting"
  React.useEffect(() => {
    if (!uploading) return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener("beforeunload", warn)
    return () => window.removeEventListener("beforeunload", warn)
  }, [uploading])

  // Moving to another page ends the upload; nothing is left half-sent in the
  // background with nobody to start the import when it finishes.
  React.useEffect(() => () => abort.current?.abort(), [])

  function discard() {
    reservation.current = undefined
    file.current = undefined
    setFlow(IDLE)
    setJob(before.current)
  }

  async function finish(from: ImportStep) {
    const sending = file.current
    const held = reservation.current
    if (!sending || !held) return

    if (from === "upload") {
      const url = held.job.upload?.url
      if (!url) {
        reservation.current = undefined
        setFlow({
          phase: "failed",
          step: "upload",
          message: uploadFailureWords("refused", 403),
        })
        return
      }
      const controller = new AbortController()
      abort.current = controller
      setFlow({ phase: "uploading", name: sending.name, sent: 0, total: sending.size })
      let drawn = 0
      try {
        await putArchive({
          url,
          file: sending,
          signal: controller.signal,
          onProgress: (sent, total) => {
            const now = Date.now()
            if (sent < total && now - drawn < PROGRESS_EVERY_MS) return
            drawn = now
            setFlow((previous) =>
              previous.phase === "uploading" ? { ...previous, sent, total } : previous,
            )
          },
        })
      } catch (error) {
        abort.current = undefined
        const failure = error instanceof UploadError ? error : null
        if (failure?.kind === "aborted") return discard()
        // ⚠ A 403 FROM STORAGE IS A LINK IT WILL NOT ACCEPT AGAIN (expired, or
        // refused), so the retry reserves a new one instead of sending to this.
        if (failure?.kind === "refused" && failure.status === 403) {
          reservation.current = undefined
        }
        setFlow({
          phase: "failed",
          step: "upload",
          message: uploadFailureWords(failure?.kind ?? "network", failure?.status ?? 0),
        })
        return
      }
      abort.current = undefined
      held.uploaded = true
    }

    setFlow({ phase: "starting" })
    const started = await startMailboxImport(address, held.job.id)
    if (!started.ok) {
      // ⚠ WHAT A REFUSED START LEAVES BEHIND: 404 and 413 end the reservation (the
      // import is gone, or the file was over the limit and was deleted), so the
      // retry reserves again; 409 says the file did not arrive, so the retry
      // sends it again; anything else (a 5xx, a dropped line) says nothing about
      // the file, which is still there, so the retry only starts.
      if (started.status === 404 || started.status === 413)
        reservation.current = undefined
      else if (started.status === 409) held.uploaded = false
      setFlow({
        phase: "failed",
        step: "start",
        message: transferRefusal(started, "start"),
      })
      return
    }

    const name = sending.name
    reservation.current = undefined
    file.current = undefined
    setJob(started.data)
    setFlow(IDLE)
    toastDone("Import started", `We are adding the mail in ${name} to ${address}.`)
  }

  /**
   * Picks up from the first step that is not done: reserves when there is no
   * usable reservation, otherwise sends or starts. Returns once the reservation
   * is settled; the rest carries on without being awaited.
   */
  async function proceed(whenStopped: ImportFlow): Promise<BeginResult> {
    const sending = file.current
    if (!sending) {
      setFlow(IDLE)
      return { kind: "refused", message: "Choose the file again." }
    }

    let step = nextImportStep(reservation.current, Date.now())
    if (step === "reserve") {
      reservation.current = undefined
      setFlow({ phase: "reserving" })
      // ⚠ THE STEP-UP HERE AND NOT AT THE START: a retry that only sends the file
      // again needs no second one, and the people it would interrupt are the ones
      // an hour into an upload.
      if (!(await stepUp())) {
        setFlow(whenStopped)
        return { kind: "declined" }
      }
      const reserved = await reserveMailboxImport(address, sending.size)
      if (!reserved.ok) {
        setFlow(whenStopped)
        return { kind: "refused", message: transferRefusal(reserved, "reserve") }
      }
      reservation.current = { job: reserved.data, uploaded: false }
      setJob(reserved.data)
      step = "upload"
    }

    void finish(step)
    return { kind: "reserved" }
  }

  /** The dialog's button: a new file, from the start. */
  function begin(chosen: File): Promise<BeginResult> {
    file.current = chosen
    reservation.current = undefined
    before.current = latest.current
    return proceed(IDLE)
  }

  /** The card's Retry: again from the step that failed. */
  async function retry(): Promise<void> {
    if (flow.phase !== "failed") return
    const stopped = flow
    const result = await proceed(stopped)
    if (result.kind === "refused") {
      setFlow({ phase: "failed", step: "reserve", message: result.message })
    }
  }

  /** Stops an upload that is going (the request is aborted), or drops a failed one. */
  function cancel() {
    if (abort.current) abort.current.abort()
    else discard()
  }

  return { flow, begin, retry, cancel }
}
