"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { MoreHorizontal, RefreshCw, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@repo/ui/components/badge"
import { Button } from "@repo/ui/components/button"
import { CopyField } from "@repo/ui/components/copy"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@repo/ui/components/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/ui/components/dropdown-menu"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@repo/ui/components/table"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { EmptyState } from "@/components/empty-state"
import { revokeApiKey, rotateApiKey } from "@/lib/actions"
import type { ApiKeyRow, CreatedApiKey } from "@/lib/types"
import { Time } from "@/components/time"

/**
 * The key list.
 *
 * ⚠ REVOKED KEYS STAY IN THE TABLE, GREYED, RATHER THAN DISAPPEARING. During an
 * incident the question is "did we revoke that one, and when" — and a key that
 * vanishes on revocation makes that unanswerable from the console. It is also
 * the difference between "I revoked it" and "I think I revoked it".
 *
 * ⚠ AND `last_used_at` IS THE MOST USEFUL COLUMN HERE. A key nothing has
 * touched in months is either dead weight or a credential somebody forgot they
 * issued; both are worth deleting, and neither is visible without this column.
 */
export function ApiKeysTable({ keys }: { keys: ApiKeyRow[] }) {
  const router = useRouter()
  const [revoking, setRevoking] = React.useState<ApiKeyRow | null>(null)
  const [rotating, setRotating] = React.useState<ApiKeyRow | null>(null)
  const [rotated, setRotated] = React.useState<CreatedApiKey | null>(null)

  if (keys.length === 0) {
    return (
      <EmptyState
        title="No API keys yet"
        description="Create one and paste it into your server's environment. It is shown once — we store only a hash."
      />
    )
  }

  return (
    <>
      <div className="overflow-hidden rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Name</TableHead>
              <TableHead className="w-[10rem]">Key</TableHead>
              <TableHead className="w-[6rem]">Mode</TableHead>
              <TableHead className="hidden w-[10rem] md:table-cell">
                Last used
              </TableHead>
              <TableHead className="hidden w-[10rem] lg:table-cell">Created</TableHead>
              <TableHead className="w-12" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {keys.map((key) => {
              const revoked = key.revoked_at !== null
              return (
                <TableRow key={key.id} className={revoked ? "opacity-50" : undefined}>
                  <TableCell className="font-medium">
                    {key.name}
                    {revoked && (
                      <Badge variant="outline" className="ml-2">
                        Revoked
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {/*
                     * ⚠ THE PREFIX ONLY, AND IT IS ALL WE HAVE. Nothing stores
                     * the key, so this is not a redaction of something we could
                     * show — it is the whole of what exists. The trailing dots
                     * say so without claiming there is a reveal.
                     */}
                    <span className="font-mono text-xs text-muted-foreground">
                      {key.prefix}…
                    </span>
                  </TableCell>
                  <TableCell>
                    <Badge variant={key.mode === "live" ? "secondary" : "outline"}>
                      {key.mode}
                    </Badge>
                  </TableCell>
                  <TableCell className="hidden text-xs text-muted-foreground md:table-cell">
                    {key.last_used_at ? (
                      <Time iso={key.last_used_at} />
                    ) : (
                      // ⚠ "Never" IS AN ANSWER AND A DASH IS NOT. A key that
                      // has never been used is the single most common thing
                      // worth deleting.
                      <span className="text-muted-foreground">Never</span>
                    )}
                  </TableCell>
                  <TableCell className="hidden text-xs text-muted-foreground lg:table-cell">
                    <Time iso={key.created_at} />
                  </TableCell>
                  <TableCell className="text-right">
                    {!revoked && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Actions for ${key.name}`}
                          >
                            <MoreHorizontal />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onSelect={() => setRotating(key)}>
                            <RefreshCw />
                            Rotate
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            variant="destructive"
                            onSelect={() => setRevoking(key)}
                          >
                            <Trash2 />
                            Revoke
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>

      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
        title={`Revoke ${revoking?.name ?? "this key"}?`}
        description="Anything using it stops sending immediately — not at the end of a cache window. This cannot be undone; create a new key instead."
        confirmLabel="Revoke key"
        onConfirm={async () => {
          if (!revoking) return false
          const result = await revokeApiKey(revoking.id)
          if (!result.ok) {
            toast.error("Could not revoke the key", { description: result.error })
            return false
          }
          toast.success(`${revoking.name} revoked`)
          setRevoking(null)
          router.refresh()
          return true
        }}
      />

      <ConfirmDialog
        open={rotating !== null}
        onOpenChange={(open) => !open && setRotating(null)}
        title={`Rotate ${rotating?.name ?? "this key"}?`}
        description="A new key is issued and the old one stops working immediately. Deploy the new value before rotating, or sending will fail in the gap."
        confirmLabel="Rotate key"
        destructive={false}
        onConfirm={async () => {
          if (!rotating) return false
          const result = await rotateApiKey(rotating.id)
          if (!result.ok) {
            toast.error("Could not rotate the key", { description: result.error })
            return false
          }
          setRotated(result.data)
          setRotating(null)
          router.refresh()
          return true
        }}
      />

      {/*
       * ⚠ THE ROTATED SECRET GETS THE SAME ONE-CHANCE TREATMENT AS A NEW ONE,
       * for the same reason: nothing stores it. Rotation is the more dangerous
       * of the two, because the old key is already dead — losing this value
       * means an outage, not just an unused row.
       */}
      <Dialog
        open={rotated !== null}
        onOpenChange={(open) => {
          if (!open) return
        }}
      >
        <DialogContent
          className="sm:max-w-lg"
          showCloseButton={false}
          onEscapeKeyDown={(event) => event.preventDefault()}
          onPointerDownOutside={(event) => event.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>Your new key</DialogTitle>
            <DialogDescription>
              The previous key stopped working the moment this one was issued. Copy it
              now — it will not be shown again.
            </DialogDescription>
          </DialogHeader>
          {rotated && <CopyField value={rotated.secret} className="py-2" />}
          <DialogFooter>
            <Button onClick={() => setRotated(null)}>I have copied it</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
