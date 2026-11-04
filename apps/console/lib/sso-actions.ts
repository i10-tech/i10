"use server"

import { api } from "@/lib/api"
import { run } from "@/lib/sso-run"
import type {
  BypassEntry,
  CreatedSetupLink,
  DirectoryConflict,
  GroupRule,
  GroupRules,
  LdapSetup,
  LdapTestOutcome,
  OidcSetup,
  OwnerExemption,
  RelinkRequest,
  SamlSetup,
  SetupLink,
  SsoConnection,
  SsoConnections,
  SsoDirectories,
  SsoDirectory,
  TestRun,
} from "@/lib/sso-types"

/**
 * Every call the SSO screens make (#340), as server actions for the reason
 * lib/actions.ts gives: the session token never reaches the browser, and a
 * refusal comes back as a value carrying the API's own words.
 *
 * ⚠ NONE OF THEM REVALIDATES A PATH. The SSO screens hold their data in client
 * state and take the new state from the action's own answer, so a write never
 * re-renders the settings tree behind an open dialog (a secret shown once
 * would vanish with it).
 *
 * ⚠ THE STEP-UP IS ASKED BY THE CALLER BEFORE THE ACTION (`useSsoCall`), NOT
 * HERE: these routes refuse a stale session with Clerk's hint and the dialog
 * lives in the browser. The API stays the guard either way.
 */

const enc = encodeURIComponent
const conn = (id: string) => `/console/identity/connections/${enc(id)}`

// ── Connections ─────────────────────────────────────────────────────────────

export async function ssoConnections() {
  return run(() => api<SsoConnections>("/console/identity/connections"))
}

export async function createSsoConnection(input: {
  name: string
  protocol: "oidc" | "saml"
  provider: string
}) {
  return run(() =>
    api<SsoConnection>("/console/identity/connections", {
      method: "POST",
      body: input,
    }),
  )
}

export interface ConnectionChange {
  name?: string
  status?: SsoConnection["status"]
  enforcement?: SsoConnection["enforcement"]
  jitEnabled?: boolean
  mfaRequired?: boolean
  relink?: SsoConnection["relink"]
  upnAsEmail?: boolean
  maxSessionSeconds?: number | null
  idleTimeoutSeconds?: number | null
}

export async function changeSsoConnection(id: string, change: ConnectionChange) {
  return run(() => api<SsoConnection>(conn(id), { method: "PATCH", body: change }))
}

export async function addSsoDomain(id: string, joinDomainId: string) {
  return run(() =>
    api<{ ok: true }>(`${conn(id)}/domains`, {
      method: "POST",
      body: { joinDomainId },
    }),
  )
}

export async function removeSsoDomain(id: string, joinDomainId: string) {
  return run(() =>
    api<{ ok: true }>(`${conn(id)}/domains/${enc(joinDomainId)}`, {
      method: "DELETE",
    }),
  )
}

export async function deleteSsoConnection(id: string) {
  return run(() => api<{ ok: true }>(conn(id), { method: "DELETE" }))
}

export async function ssoTestRuns(id: string) {
  return run(() => api<{ data: TestRun[] }>(`${conn(id)}/test-runs`))
}

// ── OIDC ────────────────────────────────────────────────────────────────────

export async function oidcSetup(id: string) {
  return run(() => api<OidcSetup>(`${conn(id)}/oidc`))
}

export async function saveOidc(
  id: string,
  body: {
    issuer?: string
    discoveryUrl?: string | null
    clientId?: string
    clientAuth?: string
    scopes?: string[]
    mfaAcrValues?: string[]
    secretExpiresAt?: string | null
  },
) {
  return run(() => api<OidcSetup>(`${conn(id)}/oidc`, { method: "PUT", body }))
}

export async function saveOidcSecret(
  id: string,
  clientSecret: string,
  secretExpiresAt?: string | null,
) {
  return run(() =>
    api<OidcSetup>(`${conn(id)}/oidc/secret`, {
      method: "PUT",
      body: {
        clientSecret,
        ...(secretExpiresAt !== undefined ? { secretExpiresAt } : {}),
      },
    }),
  )
}

export async function makeOidcKey(id: string) {
  return run(() => api<OidcSetup>(`${conn(id)}/oidc/keys`, { method: "POST" }))
}

// ── SAML ────────────────────────────────────────────────────────────────────

export async function samlSetup(id: string) {
  return run(() => api<SamlSetup>(`${conn(id)}/saml`))
}

export async function saveSaml(
  id: string,
  body: {
    idpEntityId?: string
    ssoUrl?: string
    sloUrl?: string | null
    metadataUrl?: string | null
    metadataXml?: string
    signRequests?: boolean
    requireEncryption?: boolean
    idpInitiated?: boolean
    subjectAttribute?: string | null
  },
) {
  return run(() => api<SamlSetup>(`${conn(id)}/saml`, { method: "PUT", body }))
}

export async function addSamlCertificate(id: string, certificate: string) {
  return run(() =>
    api<SamlSetup>(`${conn(id)}/saml/certificates`, {
      method: "POST",
      body: { certificate },
    }),
  )
}

export async function removeSamlCertificate(id: string, certificateId: string) {
  return run(() =>
    api<SamlSetup>(`${conn(id)}/saml/certificates/${enc(certificateId)}`, {
      method: "DELETE",
    }),
  )
}

export async function makeSamlSpKey(id: string) {
  return run(() => api<SamlSetup>(`${conn(id)}/saml/sp-key`, { method: "POST" }))
}

export async function refreshSamlMetadata(id: string) {
  return run(() => api<SamlSetup>(`${conn(id)}/saml/refresh`, { method: "POST" }))
}

// ── Group rules ─────────────────────────────────────────────────────────────

export async function groupRules(id: string) {
  return run(() => api<GroupRules>(`${conn(id)}/group-rules`))
}

export async function createGroupRule(
  id: string,
  rule: { group: string; role: "member" | "admin"; precedence: number },
) {
  return run(() =>
    api<GroupRule>(`${conn(id)}/group-rules`, { method: "POST", body: rule }),
  )
}

export async function changeGroupRule(
  id: string,
  ruleId: string,
  rule: { group?: string; role?: "member" | "admin"; precedence?: number },
) {
  return run(() =>
    api<GroupRule>(`${conn(id)}/group-rules/${enc(ruleId)}`, {
      method: "PATCH",
      body: rule,
    }),
  )
}

export async function deleteGroupRule(id: string, ruleId: string) {
  return run(() =>
    api<{ ok: true }>(`${conn(id)}/group-rules/${enc(ruleId)}`, { method: "DELETE" }),
  )
}

// ── Break-glass ─────────────────────────────────────────────────────────────

export async function bypassList(id: string) {
  return run(() => api<{ data: BypassEntry[] }>(`${conn(id)}/bypass`))
}

export async function addBypass(id: string, userId: string, reason: string) {
  return run(() =>
    api<{ userId: string; reason: string }>(`${conn(id)}/bypass`, {
      method: "POST",
      body: { userId, reason },
    }),
  )
}

export async function removeBypass(id: string, userId: string) {
  return run(() =>
    api<{ ok: true }>(`${conn(id)}/bypass/${enc(userId)}`, { method: "DELETE" }),
  )
}

export async function relinkRequests(id: string) {
  return run(() => api<{ data: RelinkRequest[] }>(`${conn(id)}/relinks`))
}

export async function approveRelink(id: string, requestId: string) {
  return run(() =>
    api<{ ok: true }>(`${conn(id)}/relinks/${enc(requestId)}/approve`, {
      method: "POST",
    }),
  )
}

export async function rejectRelink(id: string, requestId: string) {
  return run(() =>
    api<{ ok: true }>(`${conn(id)}/relinks/${enc(requestId)}/reject`, {
      method: "POST",
    }),
  )
}

export async function ownerExemption() {
  return run(() => api<OwnerExemption>("/console/identity/owner-exemption"))
}

export async function requestExemptionOff() {
  return run(() =>
    api<OwnerExemption>("/console/identity/owner-exemption/off-request", {
      method: "POST",
    }),
  )
}

export async function approveExemptionOff() {
  return run(() =>
    api<OwnerExemption>("/console/identity/owner-exemption/off-request/approve", {
      method: "POST",
    }),
  )
}

export async function withdrawExemptionOff() {
  return run(() =>
    api<OwnerExemption>("/console/identity/owner-exemption/off-request", {
      method: "DELETE",
    }),
  )
}

export async function enableExemption() {
  return run(() =>
    api<OwnerExemption>("/console/identity/owner-exemption/on", { method: "POST" }),
  )
}

// ── Setup links ─────────────────────────────────────────────────────────────

export async function setupLinks(id: string) {
  return run(() => api<{ data: SetupLink[] }>(`${conn(id)}/setup-links`))
}

export async function createSetupLink(
  id: string,
  input: { expiresInHours: number; contactEmail: string | null },
) {
  return run(() =>
    api<CreatedSetupLink>(`${conn(id)}/setup-links`, { method: "POST", body: input }),
  )
}

export async function revokeSetupLink(id: string, linkId: string, reason: string) {
  return run(() =>
    api<SetupLink>(`${conn(id)}/setup-links/${enc(linkId)}/revoke`, {
      method: "POST",
      body: { reason },
    }),
  )
}

// ── Directories ─────────────────────────────────────────────────────────────

export async function ssoDirectories() {
  return run(() => api<SsoDirectories>("/console/identity/directories"))
}

export async function createDirectory(input: {
  name: string
  provider: string
  adminEmail?: string
  domain?: string
}) {
  return run(() =>
    api<SsoDirectory>("/console/identity/directories", { method: "POST", body: input }),
  )
}

export async function changeDirectory(
  id: string,
  change: {
    name?: string
    enabled?: boolean
    createMailboxes?: boolean
    adminEmail?: string
    domain?: string
  },
) {
  return run(() =>
    api<SsoDirectory>(`/console/identity/directories/${enc(id)}`, {
      method: "PATCH",
      body: change,
    }),
  )
}

export async function checkDirectory(id: string) {
  return run(() =>
    api<{ ok: boolean; error?: string }>(
      `/console/identity/directories/${enc(id)}/check`,
      { method: "POST" },
    ),
  )
}

/** An owner lets the removals a refused Google pull would make go through, once. */
export async function confirmDirectoryRemovals(id: string, removedUsers: number) {
  return run(() =>
    api<{ ok: true }>(`/console/identity/directories/${enc(id)}/confirm-removals`, {
      method: "POST",
      body: { removedUsers },
    }),
  )
}

export async function issueDirectoryToken(id: string, overlapSeconds: number) {
  return run(() =>
    api<{ id: string; token: string; baseUrl: string }>(
      `/console/identity/directories/${enc(id)}/tokens`,
      { method: "POST", body: { overlapSeconds } },
    ),
  )
}

export async function revokeDirectoryToken(id: string, tokenId: string) {
  return run(() =>
    api<{ ok: true }>(
      `/console/identity/directories/${enc(id)}/tokens/${enc(tokenId)}`,
      { method: "DELETE" },
    ),
  )
}

export async function directoryConflicts(id: string) {
  return run(() =>
    api<{ data: DirectoryConflict[] }>(
      `/console/identity/directories/${enc(id)}/conflicts`,
    ),
  )
}

export async function retryDirectoryUser(id: string, directoryUserId: string) {
  return run(() =>
    api<{ ok: true }>(
      `/console/identity/directories/${enc(id)}/conflicts/${enc(directoryUserId)}/retry`,
      { method: "POST" },
    ),
  )
}

// ── LDAP pass-through ───────────────────────────────────────────────────────

export async function ldapSetup(id: string) {
  return run(() => api<LdapSetup>(`${conn(id)}/ldap`))
}

export async function saveLdap(
  id: string,
  body: {
    host?: string
    port?: number
    tlsMode?: "ldaps" | "starttls"
    caPem?: string | null
    searchBase?: string
    userFilter?: string
    enabled?: boolean
  },
) {
  return run(() => api<LdapSetup>(`${conn(id)}/ldap`, { method: "PUT", body }))
}

export async function saveLdapService(id: string, bindDn: string, bindSecret: string) {
  return run(() =>
    api<LdapSetup>(`${conn(id)}/ldap/service`, {
      method: "PUT",
      body: { bindDn, bindSecret },
    }),
  )
}

export async function testLdap(id: string, address: string, password?: string) {
  return run(() =>
    api<LdapTestOutcome>(`${conn(id)}/ldap/test`, {
      method: "POST",
      body: { address, ...(password ? { password } : {}) },
    }),
  )
}
