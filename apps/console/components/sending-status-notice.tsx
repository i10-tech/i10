import Link from "next/link"
import { cache } from "react"
import { AlertTriangle, ChevronRight, ShieldCheck } from "lucide-react"
import { cn } from "cn"
import { tryApi } from "@/lib/api"
import type { SendingStatus } from "@/lib/types"

/**
 * ⚠ ONE READ PER REQUEST. The rail's notice, the mobile notice and the
 * overview's banner all ask; `cache` makes that one call to the API.
 */
export const readStatus = cache(() => tryApi<SendingStatus>("/console/sending-status"))

/**
 * The one-line version, for the rail: what is wrong in four words, and a way
 * to the overview where the banner says the rest.
 */
export async function SendingStatusNotice({ className }: { className?: string }) {
  const result = await readStatus()
  if (!result.ok) return null
  const { status, health, hold } = result.data
  if (status === "enabled" && health === "healthy") return null

  const notice =
    health === "held" && hold
      ? { tone: "danger", title: "Sending on hold" }
      : status === "enabled" && health === "at_risk"
        ? { tone: "warning", title: "Sending at risk" }
        : status === "reinstated"
          ? { tone: "neutral", title: "Sending resumed" }
          : { tone: "danger", title: "Sending paused" }

  return (
    <Link
      href="/"
      className={cn(
        "group flex items-center gap-2 rounded-lg border px-2.5 py-2 text-xs font-medium",
        "transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring",
        notice.tone === "danger" &&
          "border-danger/30 bg-danger/8 text-danger hover:bg-danger/12",
        notice.tone === "warning" &&
          "border-warning/30 bg-warning/8 text-warning hover:bg-warning/12",
        notice.tone === "neutral" && "bg-muted/50 text-foreground hover:bg-muted",
        className,
      )}
    >
      {notice.tone === "neutral" ? (
        <ShieldCheck className="size-3.5 shrink-0" />
      ) : (
        <AlertTriangle className="size-3.5 shrink-0" />
      )}
      <span className="min-w-0 flex-1 truncate">{notice.title}</span>
      <ChevronRight className="size-3.5 shrink-0 opacity-60 transition-opacity group-hover:opacity-100" />
    </Link>
  )
}
