"use client"

import * as React from "react"
import { Alert } from "@repo/ui/components/alert/alert"
import { Bone, BoneScope } from "@repo/ui/components/bone/bone"
import { Button } from "@repo/ui/components/button/button"
import { DropdownMenuItem } from "@repo/ui/components/i10/menu"
import {
  DeviceLaptopIcon,
  DeviceMobileIcon,
} from "@repo/ui/components/i10/device-icons"
import {
  Section,
  SectionContent,
  SectionDescription,
  SectionTitle,
} from "@repo/ui/components/i10/page"
import {
  AddMailDeviceDialog,
  type AddMailDeviceAttempt,
} from "@/components/add-mail-device-dialog"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { RowMenu } from "@/components/list/row-menu"
import { PanelError } from "@/components/panel-error"
import { Time } from "@/components/time"
import { revokeAllMailDevices, revokeMailDevice } from "@/lib/actions"
import { startMailDeviceEnrollment } from "@/lib/mail-device-enrollment-actions"
import { startEnrollmentError } from "@/lib/mail-device-enrollments"
import {
  deviceDetail,
  deviceTitle,
  NO_DEVICES,
  platformLabel,
  type DevicesRead,
  type DevicesShape,
  type MailDevice,
} from "@/lib/mail-devices"
import { useResetOnOpen } from "@/lib/react"
import { useStepUp } from "@/lib/step-up"
import { toastDone } from "@/lib/toast"

/** What the section reads once the page has it. */
export interface MailDevicesData {
  read: DevicesRead
  /**
   * The mailbox whose devices these are, on its page; absent on the account
   * page, where they are the signed-in person's own.
   */
  address?: string
}

/** Rows are drawn at these widths, so the bars are not one length. */
const NAME_WIDTHS = ["46%", "38%", "54%", "42%"]

/**
 * The mail devices of the signed-in person (account page) or of one mailbox
 * (its page), with Revoke on each and Sign out all. Part of its page's view, so
 * with no `data` it draws the section's skeleton from the shape.
 *
 * ⚠ WHO SEES WHICH IS THE API'S: a member gets their own, an owner or admin any
 * mailbox of the workspace, and anything else is a 404, which hides the
 * section (`hidden`) rather than saying why.
 *
 * ⚠ NO STEP-UP BEFORE A REVOKE. It only removes access, and somebody who has
 * just lost a phone must be able to sign it out at once.
 *
 * ⚠ THE LIST IS THE PAGE'S. A revoke is a server action whose response carries
 * the page re-rendered, so the row leaves with no second fetch.
 */
export function MailDevices({
  on,
  shape,
  data,
}: {
  /** Which page it sits on, which decides its words (never the data: see the skeleton). */
  on: "account" | "mailbox"
  shape: DevicesShape
  data?: MailDevicesData
}) {
  const stepUp = useStepUp()
  const [revoking, setRevoking] = React.useState<{
    device: MailDevice
    open: boolean
  } | null>(null)
  const [signingOut, setSigningOut] = React.useState(false)
  const [startingAdd, setStartingAdd] = React.useState(false)
  const [adding, setAdding] = React.useState<{
    open: boolean
    attempt: AddMailDeviceAttempt
  } | null>(null)

  // Clear the one-time enrollment URL from state once the dialog's exit finishes.
  React.useEffect(() => {
    if (!adding || adding.open) return
    const timer = setTimeout(() => setAdding(null), 250)
    return () => clearTimeout(timer)
  }, [adding])

  if (shape.devices === "hidden") return null

  const ownPage = on === "account"
  const devices = data?.read.state === "ok" ? data.read.list.data : NO_DEVICES
  const rows: readonly (MailDevice | undefined)[] = data
    ? devices
    : Array.from({ length: shape.deviceRows }, () => undefined)

  async function startAddDevice() {
    if (!data || startingAdd) return
    setStartingAdd(true)
    try {
      if (!(await stepUp())) return
      const result = await startMailDeviceEnrollment()
      if (result.ok) {
        setAdding({
          open: true,
          attempt: {
            kind: "enrollment",
            started: result.data,
            startedAt: Date.now(),
          },
        })
      } else {
        setAdding({
          open: true,
          attempt: { kind: "error", error: startEnrollmentError(result) },
        })
      }
    } finally {
      setStartingAdd(false)
    }
  }

  return (
    <Section
      id={ownPage ? "mail-devices" : undefined}
      className={ownPage ? "scroll-mt-6" : undefined}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <SectionTitle>{ownPage ? "Mail devices" : "Devices"}</SectionTitle>
          <SectionDescription>
            {ownPage
              ? "The iPhones, iPads and Macs that sign in to your mailbox with their own code instead of your password."
              : "The iPhones, iPads and Macs that sign in to this mailbox with their own code instead of a password."}
          </SectionDescription>
        </div>
        {(ownPage || shape.devices === "list") && (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {shape.devices === "list" && (
              <Button variant="secondary" size="sm" onClick={() => setSigningOut(true)}>
                Sign out all devices
              </Button>
            )}
            {ownPage && (
              <Button
                variant="primary"
                size="sm"
                loading={startingAdd}
                onClick={() => void startAddDevice()}
              >
                Add a device
              </Button>
            )}
          </div>
        )}
      </div>
      <SectionContent>
        {shape.devices === "error" ? (
          <PanelError
            title="Could not load the devices"
            message="Reload the page to try again."
          />
        ) : shape.devices === "empty" ? (
          <div className="rounded-2xl border bg-card px-4 py-6">
            <p className="text-sm text-muted-foreground">
              {ownPage
                ? "No mail devices yet. Add an iPhone, iPad or Mac to sign in to Apple Mail without your password."
                : "No devices sign in to this mailbox with their own code yet."}
            </p>
          </div>
        ) : (
          <ul className="divide-y rounded-2xl border bg-card">
            {rows.map((device, i) => (
              <BoneScope key={device?.id ?? i} id={`device-${i}`} unit>
                <li className="flex items-center justify-between gap-4 px-4 py-3">
                  <span className="flex min-w-0 items-center gap-3">
                    <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
                      <Bone id="icon" shape="box" width={16} height={16} radius={4}>
                        {device &&
                          (device.platform === "macos" ? (
                            <DeviceLaptopIcon className="size-4" aria-hidden />
                          ) : (
                            <DeviceMobileIcon className="size-4" aria-hidden />
                          ))}
                      </Bone>
                    </span>
                    <span className="min-w-0 space-y-0.5">
                      <span className="block truncate text-sm">
                        <Bone id="name" width={NAME_WIDTHS[i % NAME_WIDTHS.length]}>
                          {device && deviceTitle(device)}
                        </Bone>
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        <Bone id="meta" lineHeight={16} width={220}>
                          {device && <DeviceMeta device={device} />}
                        </Bone>
                      </span>
                    </span>
                  </span>
                  {device && (
                    <RowMenu visible label={deviceTitle(device)}>
                      <DropdownMenuItem
                        className="text-danger"
                        onSelect={() => setRevoking({ device, open: true })}
                      >
                        Revoke
                      </DropdownMenuItem>
                    </RowMenu>
                  )}
                </li>
              </BoneScope>
            ))}
          </ul>
        )}
      </SectionContent>

      {/* The dialogs are closed until somebody asks, so a skeleton has none. */}
      <span data-skeleton="skip" className="contents">
        {/* ⚠ CLOSING KEEPS THE DEVICE, so the dialog plays its exit with its content. */}
        {revoking && (
          <RevokeDeviceDialog
            device={revoking.device}
            open={revoking.open}
            onOpenChange={(open) => setRevoking((r) => (r ? { ...r, open } : r))}
          />
        )}
        {data && (
          <SignOutAllDialog
            address={data.address}
            open={signingOut}
            onOpenChange={setSigningOut}
          />
        )}
        {ownPage && adding && (
          <AddMailDeviceDialog
            open={adding.open}
            attempt={adding.attempt}
            restarting={startingAdd}
            onOpenChange={(open) => setAdding((a) => (a ? { ...a, open } : a))}
            onStartAgain={() => void startAddDevice()}
          />
        )}
      </span>
    </Section>
  )
}

/** "iPhone · Model · Serial · Added 2 days ago · Last used an hour ago", where known. */
function DeviceMeta({ device }: { device: MailDevice }) {
  const detail = deviceDetail(device)
  return (
    <>
      {platformLabel(device.platform)}
      {detail && <> · {detail}</>} · Added <Time iso={device.created_at} /> ·{" "}
      {device.last_used_at ? (
        <>
          Last used <Time iso={device.last_used_at} />
        </>
      ) : (
        "Never used"
      )}
    </>
  )
}

function RevokeDeviceDialog({
  device,
  open,
  onOpenChange,
}: {
  device: MailDevice
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [refusal, setRefusal] = React.useState<string | null>(null)
  useResetOnOpen(open, () => setRefusal(null))
  const title = deviceTitle(device)

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Revoke ${title}?`}
      description={`It is signed out of ${device.email} within seconds and cannot sign in again. The password and other devices keep working.`}
      confirmLabel="Revoke"
      doneLabel="Revoked"
      onConfirm={async () => {
        setRefusal(null)
        const result = await revokeMailDevice(device.id)
        if (!result.ok) {
          setRefusal(
            result.status === 404 ? "This device was already revoked." : result.error,
          )
          return false
        }
        toastDone(
          "Device revoked",
          `${title} can no longer sign in to ${device.email}.`,
        )
        return true
      }}
    >
      {refusal && (
        <Alert tone="danger" title="Could not revoke the device">
          {refusal}
        </Alert>
      )}
    </ConfirmDialog>
  )
}

function SignOutAllDialog({
  address,
  open,
  onOpenChange,
}: {
  address: string | undefined
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [refusal, setRefusal] = React.useState<string | null>(null)
  useResetOnOpen(open, () => setRefusal(null))

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Sign out all mail devices?"
      description={
        address
          ? `Every device that signs in to ${address} with its own code is signed out within seconds. The password keeps working.`
          : "Every device that signs in to your mailbox with its own code is signed out within seconds. Your password keeps working."
      }
      confirmLabel="Sign out all"
      doneLabel="Signed out"
      onConfirm={async () => {
        setRefusal(null)
        const result = await revokeAllMailDevices(address)
        if (!result.ok) {
          setRefusal(result.error)
          return false
        }
        const n = result.data.revoked
        toastDone(
          "Devices signed out",
          n === 1 ? "One device was signed out." : `${n} devices were signed out.`,
        )
        return true
      }}
    >
      {refusal && (
        <Alert tone="danger" title="Could not sign out the devices">
          {refusal}
        </Alert>
      )}
    </ConfirmDialog>
  )
}
