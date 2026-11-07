import type { SsoDirectory } from "@/lib/sso-types"

export const PROVIDER_LABEL: Record<string, string> = {
  okta: "Okta",
  entra: "Microsoft Entra ID",
  google: "Google Workspace",
  generic: "Custom SCIM",
}

export const OVERLAP = [
  { value: "0", label: "End the old tokens now" },
  { value: String(3600), label: "Keep them for 1 hour" },
  { value: String(24 * 3600), label: "Keep them for 1 day" },
  { value: String(7 * 24 * 3600), label: "Keep them for 7 days" },
]

export function directoryStateText(d: SsoDirectory): string {
  if (d.provider === "google") {
    if (d.lastSyncError) return "Sync error"
    if (d.adminEmail && d.domain) return `Acting as ${d.adminEmail} for ${d.domain}`
    return `${d.users} ${d.users === 1 ? "person" : "people"}`
  }
  const parts: string[] = [`${d.users} ${d.users === 1 ? "person" : "people"}`]
  if (d.pending > 0) parts.push(`${d.pending} waiting`)
  if (d.conflicts > 0)
    parts.push(`${d.conflicts} ${d.conflicts === 1 ? "conflict" : "conflicts"}`)
  return parts.join(" · ")
}
