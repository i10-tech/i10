"use server"

import { api } from "@/lib/api"
import type { SiemBody } from "@/lib/siem"
import { run } from "@/lib/sso-run"
import type {
  DirectoryGroup,
  IpAllowlist,
  LeaverDefault,
  Mailboxes,
  DeprovisionedPerson,
  NextChoice,
  RotatedDeprovisionedKey,
  SavedIpAllowlist,
  SessionPolicy,
  SiemSettingsAnswer,
  SiemTestResult,
} from "@/lib/sso-types"

/**
 * The calls of directory mail (#344), the session, second-factor and network
 * policies (#345), as server actions for the reason
 * lib/sso-actions.ts gives. Same rules: none revalidates a path (the screens
 * take the new state from the answer), and the step-up is asked by the caller
 * before the action (`useSsoCall`).
 */

const enc = encodeURIComponent

// ── Directory mail ──────────────────────────────────────────────────────────

export async function directoryGroups(directoryId: string) {
  return run(() =>
    api<{ data: DirectoryGroup[] }>(
      `/console/identity/directories/${enc(directoryId)}/groups`,
    ),
  )
}

export async function setGroupMail(
  directoryId: string,
  groupId: string,
  input: { address: string; kind: "list" | "shared" },
) {
  return run(() =>
    api<{ ok: true }>(
      `/console/identity/directories/${enc(directoryId)}/groups/${enc(groupId)}/mail`,
      { method: "PUT", body: input },
    ),
  )
}

export async function clearGroupMail(directoryId: string, groupId: string) {
  return run(() =>
    api<{ ok: true }>(
      `/console/identity/directories/${enc(directoryId)}/groups/${enc(groupId)}/mail`,
      { method: "DELETE" },
    ),
  )
}

export async function mailboxes() {
  return run(() => api<Mailboxes>("/console/identity/mailboxes"))
}

export async function chooseMailboxNext(userId: string, choice: NextChoice) {
  return run(() =>
    api<{ ok: true; next: string }>(`/console/identity/mailboxes/${enc(userId)}/next`, {
      method: "PUT",
      body: choice,
    }),
  )
}

export async function saveLeaverDefault(
  input:
    { action: "keep" | "forward_manager" } | { action: "delete_after"; days: number },
) {
  return run(() =>
    api<LeaverDefault>("/console/identity/mail/leavers", {
      method: "PUT",
      body: input,
    }),
  )
}

// ── Session, second factor and network ──────────────────────────────────────

export async function sessionPolicy() {
  return run(() => api<SessionPolicy>("/console/identity/session-policy"))
}

export async function saveSessionPolicy(input: {
  maxSessionSeconds: number | null
  idleTimeoutSeconds: number | null
}) {
  return run(() =>
    api<{ maxSessionSeconds: number | null; idleTimeoutSeconds: number | null }>(
      "/console/identity/session-policy",
      { method: "PUT", body: input },
    ),
  )
}

export async function secondFactorPolicy() {
  return run(() => api<{ required: boolean }>("/console/identity/second-factor-policy"))
}

export async function saveSecondFactorPolicy(required: boolean) {
  return run(() =>
    api<{ required: boolean }>("/console/identity/second-factor-policy", {
      method: "PUT",
      body: { required },
    }),
  )
}

export async function ipAllowlist() {
  return run(() => api<IpAllowlist>("/console/identity/ip-allowlist"))
}

export async function saveIpAllowlist(input: {
  console: boolean
  apiKeys: boolean
  ranges: string[]
  confirmLockout?: boolean
}) {
  return run(() =>
    api<SavedIpAllowlist>("/console/identity/ip-allowlist", {
      method: "PUT",
      body: input,
    }),
  )
}

// ── SIEM export ─────────────────────────────────────────────────────────────

export async function siemSettings() {
  return run(() => api<SiemSettingsAnswer>("/console/identity/siem"))
}

export async function saveSiem(input: SiemBody) {
  return run(() =>
    api<SiemSettingsAnswer>("/console/identity/siem", { method: "PUT", body: input }),
  )
}

export async function removeSiem() {
  return run(() =>
    api<{ configured: false }>("/console/identity/siem", { method: "DELETE" }),
  )
}

export async function testSiem() {
  return run(() =>
    api<SiemTestResult>("/console/identity/siem/test", { method: "POST" }),
  )
}

// ── API keys of a deprovisioned person ──────────────────────────────────────

export async function rotateDeprovisionedKey(userId: string, keyId: string) {
  return run(() =>
    api<RotatedDeprovisionedKey>(
      `/console/identity/deprovisioned/${enc(userId)}/api-keys/${enc(keyId)}/rotate`,
      { method: "POST" },
    ),
  )
}

export async function revokeDeprovisionedKey(userId: string, keyId: string) {
  return run(() =>
    api<{ id: string; revoked: true }>(
      `/console/identity/deprovisioned/${enc(userId)}/api-keys/${enc(keyId)}/revoke`,
      { method: "POST" },
    ),
  )
}

/** Every removed person who still has a live key, with those keys. */
export async function deprovisionedPeople() {
  return run(() =>
    api<{ data: DeprovisionedPerson[] }>("/console/identity/deprovisioned/api-keys"),
  )
}
