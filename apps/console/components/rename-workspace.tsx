"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Button } from "@repo/ui/components/button"
import { Input } from "@repo/ui/components/input"
import { Spinner } from "@repo/ui/components/spinner"
import { renameWorkspace } from "@/lib/actions"
import { useSyncedState } from "@/lib/react"

export function RenameWorkspace({ current }: { current: string }) {
  const router = useRouter()
  // ⚠ FOLLOWS THE SERVER VALUE WHEN IT CHANGES. Without that, saving leaves the
  // input holding what you typed while the rest of the page has re-rendered
  // from the server — fine until somebody renames it in another tab, at which
  // point this field silently disagrees with the heading above it.
  const [name, setName] = useSyncedState(current)
  const [pending, setPending] = React.useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (pending || !name.trim() || name.trim() === current) return

    setPending(true)
    const result = await renameWorkspace(name.trim())
    setPending(false)

    if (!result.ok) {
      toast.error("Could not rename the workspace", { description: result.error })
      return
    }

    toast.success("Workspace renamed")
    router.refresh()
  }

  return (
    <form onSubmit={submit} className="flex max-w-md items-center gap-2">
      <Input
        value={name}
        onChange={(event) => setName(event.target.value)}
        maxLength={120}
        aria-label="Workspace name"
      />
      <Button type="submit" disabled={pending || !name.trim() || name.trim() === current}>
        {pending && <Spinner />}
        Save
      </Button>
    </form>
  )
}
