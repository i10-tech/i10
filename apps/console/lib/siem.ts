import type { SiemView } from "@/lib/sso-types"

/**
 * The SIEM export's form (#345): what the person types, and the body the API
 * takes (apps/api/src/identity/siem.ts `siemSettingsSchema`, strict).
 *
 * ⚠ THE SECRET ACCESS KEY IS WRITE-ONLY. The API returns only a hint
 * (`••••abcd`), so the form starts with the key empty. On a later save an empty
 * key is left OUT of the body, which keeps the stored one; it is never sent as
 * the hint or as an empty string.
 */

export interface SiemDraft {
  endpoint: string
  bucket: string
  region: string
  prefix: string
  accessKeyId: string
  secretAccessKey: string
  enabled: boolean
}

export interface SiemBody {
  endpoint: string
  bucket: string
  region: string
  prefix: string
  accessKeyId: string
  enabled: boolean
  secretAccessKey?: string
}

export function draftOfSiem(view: SiemView | null): SiemDraft {
  return {
    endpoint: view?.endpoint ?? "",
    bucket: view?.bucket ?? "",
    region: view?.region ?? "",
    prefix: view?.prefix ?? "",
    accessKeyId: view?.accessKeyId ?? "",
    secretAccessKey: "",
    enabled: view?.enabled ?? true,
  }
}

export function siemBody(draft: SiemDraft): SiemBody {
  const secret = draft.secretAccessKey.trim()
  return {
    endpoint: draft.endpoint.trim(),
    bucket: draft.bucket.trim(),
    region: draft.region.trim(),
    prefix: draft.prefix.trim(),
    accessKeyId: draft.accessKeyId.trim(),
    enabled: draft.enabled,
    ...(secret ? { secretAccessKey: secret } : {}),
  }
}

/** What is missing before a save can work, or null. The API still validates. */
export function siemMissing(draft: SiemDraft, configured: boolean): string | null {
  if (!draft.endpoint.trim()) return "Enter the endpoint."
  if (!draft.bucket.trim()) return "Enter the bucket."
  if (!draft.region.trim()) return "Enter the region."
  if (!draft.accessKeyId.trim()) return "Enter the access key id."
  if (!configured && !draft.secretAccessKey.trim())
    return "Enter the secret access key."
  return null
}

/** Whether saving would change anything stored. A typed key always counts. */
export function siemChanged(draft: SiemDraft, view: SiemView | null): boolean {
  if (!view) return true
  const before = draftOfSiem(view)
  const body = siemBody(draft)
  return (
    body.secretAccessKey !== undefined ||
    body.endpoint !== before.endpoint ||
    body.bucket !== before.bucket ||
    body.region !== before.region ||
    body.prefix !== before.prefix ||
    body.accessKeyId !== before.accessKeyId ||
    body.enabled !== before.enabled
  )
}
