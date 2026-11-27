"use client"

import * as React from "react"
import { ExternalLink, RotateCw } from "lucide-react"
import { Alert } from "@repo/ui/components/alert/alert"
import { Button } from "@repo/ui/components/button/button"
import { Dialog, DialogContent } from "@repo/ui/components/dialog/dialog"
import { ButtonLink } from "@repo/ui/components/i10/button-link"
import {
  DeviceLaptopIcon,
  DeviceMobileIcon,
} from "@repo/ui/components/i10/device-icons"
import { DialogFooter } from "@repo/ui/components/i10/dialog-footer"
import { QrCode } from "@repo/ui/components/i10/qr-code"
import { Spinner } from "@repo/ui/components/i10/spinner"
import { StepStage } from "@repo/ui/components/i10/step-stage"
import {
  cancelMailDeviceEnrollment,
  readMailDeviceEnrollment,
} from "@/lib/mail-device-enrollment-actions"
import {
  enrollmentDeviceLabel,
  enrollmentStatusCopy,
  formatTimeLeft,
  isEnrollmentLive,
  MAC_MAIL_SETUP_STEPS,
  nextEnrollmentPollDelay,
  shouldPollEnrollment,
  startEnrollmentError,
  type EnrollmentStatus,
  type MailDeviceEnrollment,
  type StartedEnrollment,
  type StartEnrollmentError,
} from "@/lib/mail-device-enrollments"
import { toastDone } from "@/lib/toast"

export type AddMailDeviceAttempt =
  | { kind: "enrollment"; started: StartedEnrollment; startedAt: number }
  | { kind: "error"; error: StartEnrollmentError }

/**
 * Dialog for Apple OTA mail device enrollment (#383 PR 5b).
 *
 * ⚠ THE ENROLLMENT URL IS HELD ONLY IN MEMORY WHILE THIS DIALOG IS OPEN. It is
 * never written to storage, query parameters or logs, and the parent clears
 * `attempt` once the dialog finishes closing.
 *
 * ⚠ CLOSING WHILE LIVE SENDS A BEST-EFFORT DELETE; UNMOUNT ONLY STOPS POLLING.
 * Firing DELETE from an effect cleanup would cancel a brand-new enrollment
 * under React StrictMode's dev double-mount.
 */
export function AddMailDeviceDialog({
  open,
  attempt,
  restarting,
  onOpenChange,
  onStartAgain,
}: {
  open: boolean
  attempt: AddMailDeviceAttempt | null
  restarting: boolean
  onOpenChange: (open: boolean) => void
  onStartAgain: () => void
}) {
  const [polled, setPolled] = React.useState<MailDeviceEnrollment | null>(null)
  const [attestedId, setAttestedId] = React.useState<string | null>(null)
  const [pollError, setPollError] = React.useState<{
    id: string
    error: StartEnrollmentError
  } | null>(null)
  const [nowMs, setNowMs] = React.useState(() => Date.now())

  const sealedToastId = React.useRef<string | null>(null)
  const cancelledIds = React.useRef<Set<string>>(new Set())
  const liveRef = React.useRef<{ id: string; status: EnrollmentStatus } | null>(null)

  const started = attempt?.kind === "enrollment" ? attempt.started : null
  const enrollmentId = started?.id ?? null

  const currentView: MailDeviceEnrollment | null = React.useMemo(() => {
    if (!started) return null
    if (polled && polled.id === started.id) return polled
    return {
      id: started.id,
      status: "open",
      expiresAt: started.expiresAt,
      refusal: null,
      platform: null,
      model: null,
      deviceName: null,
      deviceId: null,
      needsMailSetup: false,
    }
  }, [started, polled])

  const activePollError =
    enrollmentId !== null && pollError?.id === enrollmentId ? pollError.error : null
  const fatalError = attempt?.kind === "error" ? attempt.error : activePollError

  const currentStatus = currentView?.status ?? null
  const polling =
    open &&
    enrollmentId !== null &&
    fatalError === null &&
    currentStatus !== null &&
    shouldPollEnrollment(currentStatus)

  React.useEffect(() => {
    liveRef.current =
      enrollmentId && currentStatus ? { id: enrollmentId, status: currentStatus } : null
  }, [enrollmentId, currentStatus])

  // Poll GET every ~2s while open or attested; stop immediately on terminal status or unmount.
  React.useEffect(() => {
    if (!polling || !enrollmentId) return

    let stopped = false
    let inFlight = false
    let failures = 0
    let timer: ReturnType<typeof setTimeout> | undefined

    const schedule = () => {
      if (stopped) return
      timer = setTimeout(tick, nextEnrollmentPollDelay(failures))
    }

    async function tick() {
      if (stopped || inFlight || !enrollmentId) return
      inFlight = true
      let result: Awaited<ReturnType<typeof readMailDeviceEnrollment>> | null = null
      try {
        result = await readMailDeviceEnrollment(enrollmentId)
      } catch {
        result = null
      }
      inFlight = false
      if (stopped) return

      if (result?.ok) {
        failures = 0
        const next = result.data
        setPolled(next)
        if (next.status === "attested") setAttestedId(enrollmentId)
        if (next.status === "sealed") {
          if (sealedToastId.current !== enrollmentId) {
            sealedToastId.current = enrollmentId
            const label = enrollmentDeviceLabel(next)
            toastDone(
              "Device added",
              next.needsMailSetup
                ? `${label} was added. Finish the two steps in Apple Mail to connect.`
                : `${label} can now sign in to your mailbox.`,
            )
          }
          return
        }
        if (!shouldPollEnrollment(next.status)) return
        schedule()
        return
      }

      if (
        result &&
        (result.status === 401 || result.status === 403 || result.status === 404)
      ) {
        setPollError({
          id: enrollmentId,
          error:
            result.status === 404
              ? {
                  title: "Setup session ended",
                  message:
                    "This setup session could not be found. Start again to add a device.",
                  retryable: true,
                }
              : startEnrollmentError(result),
        })
        return
      }

      failures += 1
      schedule()
    }

    const onVisibility = () => {
      if (document.visibilityState !== "visible" || inFlight || stopped) return
      clearTimeout(timer)
      void tick()
    }

    document.addEventListener("visibilitychange", onVisibility)
    schedule()

    return () => {
      stopped = true
      clearTimeout(timer)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [polling, enrollmentId])

  // Keep the time-left countdown current while the enrollment is live.
  React.useEffect(() => {
    if (!polling) return
    const interval = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(interval)
  }, [polling])

  function handleOpenChange(nextOpen: boolean) {
    if (restarting && !nextOpen) return
    if (!nextOpen) {
      const live = liveRef.current
      if (live && isEnrollmentLive(live.status) && !cancelledIds.current.has(live.id)) {
        cancelledIds.current.add(live.id)
        void cancelMailDeviceEnrollment(live.id).catch(() => {})
      }
    }
    onOpenChange(nextOpen)
  }

  const copy = currentView
    ? enrollmentStatusCopy(currentView, {
        wasAttested: enrollmentId !== null && attestedId === enrollmentId,
      })
    : null

  const effectiveNowMs =
    attempt?.kind === "enrollment" ? Math.max(nowMs, attempt.startedAt) : nowMs
  const timeLeft =
    currentView && shouldPollEnrollment(currentView.status)
      ? formatTimeLeft(currentView.expiresAt, effectiveNowMs)
      : null

  const stage = fatalError
    ? "error"
    : !currentView
      ? "error"
      : currentView.status === "open"
        ? "open"
        : currentView.status === "attested"
          ? "attested"
          : currentView.status === "sealed"
            ? "sealed"
            : "terminal"

  const dialogTitle = stage === "sealed" ? "Device added" : "Add a mail device"
  const dialogDescription =
    stage === "open"
      ? "Add an iPhone, iPad or Mac to Apple Mail with its own device code instead of your password."
      : stage === "attested"
        ? "Finish installing the configuration profile on your device."
        : stage === "sealed"
          ? "Your device has been added to your mailbox."
          : "Device setup did not finish."

  const deviceLabel = currentView ? enrollmentDeviceLabel(currentView) : null
  const deviceSubline =
    currentView?.model && currentView.model !== deviceLabel ? currentView.model : null

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        title={dialogTitle}
        description={dialogDescription}
        style={{ width: "min(calc(100vw - 2rem), 480px)" }}
      >
        <p className="sr-only" role="status" aria-live="polite">
          {fatalError ? fatalError.title : (copy?.title ?? "")}
        </p>

        <StepStage step={stage}>
          {stage === "open" && started && copy && (
            <div className="space-y-5">
              <div className="flex flex-col items-center gap-3">
                <div className="rounded-2xl border bg-background p-1">
                  <QrCode value={started.url} title="Mail device setup QR code" />
                </div>
                <ButtonLink
                  native
                  variant="secondary"
                  size="sm"
                  href={started.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <ExternalLink className="size-3.5" aria-hidden="true" />
                  Open on this device
                </ButtonLink>
              </div>

              <dl className="space-y-2.5 rounded-xl border bg-muted/40 px-3.5 py-3 text-xs text-muted-foreground">
                <div>
                  <dt className="font-medium text-foreground">iPhone or iPad</dt>
                  <dd className="mt-0.5">
                    Scan the QR code with the camera, or open the link above on that
                    device, then install the profile in Settings.
                  </dd>
                </div>
                <div>
                  <dt className="font-medium text-foreground">Mac</dt>
                  <dd className="mt-0.5">
                    Open the link above on your Mac (Apple silicon, macOS 14 or later)
                    to download the profile, then install it in System Settings &gt;
                    Profiles.
                  </dd>
                </div>
              </dl>

              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="flex items-center gap-2 text-muted-foreground">
                  <Spinner aria-hidden="true" />
                  {copy.title}
                </span>
                {timeLeft && (
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {timeLeft}
                  </span>
                )}
              </div>

              <DialogFooter className="mt-0">
                <Button variant="ghost" onClick={() => handleOpenChange(false)}>
                  Cancel
                </Button>
              </DialogFooter>
            </div>
          )}

          {stage === "attested" && currentView && copy && (
            <div className="space-y-5">
              <div className="flex items-center gap-3 rounded-xl border bg-card px-3.5 py-3">
                <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
                  {currentView.platform === "macos" ? (
                    <DeviceLaptopIcon className="size-4" aria-hidden />
                  ) : (
                    <DeviceMobileIcon className="size-4" aria-hidden />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">
                    {deviceLabel}
                  </p>
                  {deviceSubline && (
                    <p className="truncate text-xs text-muted-foreground">
                      {deviceSubline}
                    </p>
                  )}
                </div>
              </div>

              <p className="text-sm text-muted-foreground">{copy.message}</p>

              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="flex items-center gap-2 text-muted-foreground">
                  <Spinner aria-hidden="true" />
                  {copy.title}
                </span>
                {timeLeft && (
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {timeLeft}
                  </span>
                )}
              </div>

              <DialogFooter className="mt-0">
                <Button variant="ghost" onClick={() => handleOpenChange(false)}>
                  Cancel
                </Button>
              </DialogFooter>
            </div>
          )}

          {stage === "sealed" && currentView && copy && (
            <div className="space-y-4">
              <Alert tone="success" title={copy.title}>
                {copy.message}
              </Alert>

              <div className="flex items-center gap-3 rounded-xl border bg-card px-3.5 py-3">
                <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
                  {currentView.platform === "macos" ? (
                    <DeviceLaptopIcon className="size-4" aria-hidden />
                  ) : (
                    <DeviceMobileIcon className="size-4" aria-hidden />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">
                    {deviceLabel}
                  </p>
                  {deviceSubline && (
                    <p className="truncate text-xs text-muted-foreground">
                      {deviceSubline}
                    </p>
                  )}
                </div>
              </div>

              {copy.showMacSetup && (
                <div className="space-y-2 rounded-xl border bg-muted/40 p-3.5">
                  <p className="text-sm font-medium text-foreground">
                    Finish setup in Apple Mail
                  </p>
                  <ol className="list-decimal space-y-1.5 pl-4 text-xs text-muted-foreground">
                    {MAC_MAIL_SETUP_STEPS.map((step) => (
                      <li key={step}>{step}</li>
                    ))}
                  </ol>
                </div>
              )}

              <DialogFooter className="mt-0">
                <Button variant="primary" onClick={() => handleOpenChange(false)}>
                  Done
                </Button>
              </DialogFooter>
            </div>
          )}

          {stage === "terminal" && currentView && copy && (
            <div className="space-y-4">
              <Alert
                tone={currentView.status === "refused" ? "danger" : "warning"}
                title={copy.title}
              >
                {copy.message}
              </Alert>

              <DialogFooter className="mt-0">
                <Button
                  variant="ghost"
                  onClick={() => handleOpenChange(false)}
                  disabled={restarting}
                >
                  Close
                </Button>
                {copy.canRestart && (
                  <Button variant="primary" loading={restarting} onClick={onStartAgain}>
                    <RotateCw className="size-3.5" aria-hidden="true" />
                    Start again
                  </Button>
                )}
              </DialogFooter>
            </div>
          )}

          {stage === "error" && fatalError && (
            <div className="space-y-4">
              <Alert tone="danger" title={fatalError.title}>
                {fatalError.message}
              </Alert>

              <DialogFooter className="mt-0">
                <Button
                  variant="ghost"
                  onClick={() => handleOpenChange(false)}
                  disabled={restarting}
                >
                  Close
                </Button>
                {fatalError.retryable && (
                  <Button variant="primary" loading={restarting} onClick={onStartAgain}>
                    <RotateCw className="size-3.5" aria-hidden="true" />
                    Start again
                  </Button>
                )}
              </DialogFooter>
            </div>
          )}
        </StepStage>
      </DialogContent>
    </Dialog>
  )
}
