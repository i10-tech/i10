"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Plus } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@repo/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@repo/ui/components/dialog"
import { FloatingInput } from "@repo/ui/components/floating-field"
import { Spinner } from "@repo/ui/components/spinner"
import { addSuppression } from "@/lib/actions"

/**
 * ⚠ ADDING BY HAND IS FOR THE ADDRESS THAT KEEPS BOUNCING SOFTLY, OR THE ONE
 * SOMEBODY ASKED TO BE REMOVED OVER THE PHONE. It is deliberately a small,
 * quiet control: the list should mostly fill itself from real bounces and
 * complaints, and an account whose suppressions are mostly manual has a data
 * quality problem upstream rather than a suppression problem here.
 */
export function AddSuppressionButton() {
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const [address, setAddress] = React.useState("")
  const [pending, setPending] = React.useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (pending) return

    setPending(true)
    const result = await addSuppression(address.trim())
    setPending(false)

    if (!result.ok) {
      toast.error("Could not suppress that address", { description: result.error })
      return
    }

    toast.success("Address suppressed", {
      description: "We will skip it on every future send.",
    })
    setAddress("")
    setOpen(false)
    router.refresh()
  }

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Plus />
        Suppress an address
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <form onSubmit={submit}>
            <DialogHeader>
              <DialogTitle>Suppress an address</DialogTitle>
              <DialogDescription>
                We will skip this address on every send from this workspace,
                transactional and marketing alike.
              </DialogDescription>
            </DialogHeader>

            <div className="py-4">
              <FloatingInput
                id="suppress-address"
                label="Email address"
                type="email"
                value={address}
                onChange={(event) => setAddress(event.target.value)}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                className="font-mono text-xs"
                required
                autoFocus
                hint="e.g. bounced@example.com"
              />
            </div>

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={pending || !address.includes("@")}>
                {pending && <Spinner />}
                Suppress
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
