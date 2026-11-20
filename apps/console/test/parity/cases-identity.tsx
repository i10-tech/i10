import { defineView } from "./harness"
import { folder, iso, rows, template } from "./fixtures"

// ⚠ LOADED AFTER harness.tsx HAS MOCKED `server-only` (see cases-lists.tsx).
const { previewFor } = await import("@/lib/preview")
const { SecurityView } = await import("@/components/security-view")
const { securityShape } = await import("@/lib/shapes/security")
const { SecurityAuditView } = await import("@/components/security-audit-view")
const { securityAuditShape } = await import("@/lib/shapes/security-audit")
const { SsoHomeView } = await import("@/components/sso-home-view")
const { ssoShape } = await import("@/lib/shapes/sso")
const { SsoConnectView } = await import("@/components/sso-connect-view")
const { ssoConnectShape } = await import("@/lib/shapes/sso-connect")
const { SsoConnectionPageView } = await import("@/components/sso-connection-page-view")
const { ssoConnectionShape } = await import("@/lib/shapes/sso-connection")
const { TemplateFolderView } = await import("@/components/template-folder-view")
const { templateFolderShape } = await import("@/lib/shapes/template-folder")

import type { SecurityAuditData } from "@/lib/shapes/security-audit"
import type { SecurityData } from "@/lib/shapes/security"
import type { SsoConnectData } from "@/lib/shapes/sso-connect"
import type { SsoConnectionData } from "@/lib/shapes/sso-connection"
import type { SsoData } from "@/lib/shapes/sso"
import type {
  TemplateFolderData,
  TemplateFolderShape,
} from "@/lib/shapes/template-folder"
import type {
  IdentityEvent,
  IpAllowlist,
  OwnerExemption,
  SessionPolicy,
  SiemSettingsAnswer,
  SsoAbilities,
  SsoConnections,
  SsoDirectories,
} from "@/lib/sso-types"

const api = <T,>(path: string, query?: Record<string, string | number>) =>
  previewFor(path, query) as T

const admin: SsoAbilities = { manage: true, owner: true, userId: "usr_1" }
const member: SsoAbilities = { manage: false, owner: false, userId: "usr_2" }
const EMPTY: SsoConnections = {
  data: [],
  protocols: [],
  presets: { oidc: [], saml: [] },
}

const connections = () => api<SsoConnections>("/console/identity/connections")

// ── Security ─────────────────────────────────────────────────────────────

const securityData =
  (over: Partial<SecurityData> = {}) =>
  (): SecurityData => ({
    abilities: admin,
    available: true,
    session: api<SessionPolicy>("/console/identity/session-policy"),
    secondFactor: api<{ required: boolean }>("/console/identity/second-factor-policy"),
    siem: api<SiemSettingsAnswer>("/console/identity/siem"),
    allowlist: api<IpAllowlist>("/console/identity/ip-allowlist"),
    exemption: { enabled: true, pending: null } as OwnerExemption,
    ...over,
  })

const auditData =
  (over: Partial<SecurityAuditData> = {}) =>
  (): SecurityAuditData => ({
    canManage: true,
    available: true,
    events: api<{ data: IdentityEvent[] }>("/console/identity/events").data,
    user: null,
    limit: 50,
    nextLimit: 100,
    clerkEnabled: false,
    ...over,
  })

// ── SSO ──────────────────────────────────────────────────────────────────

const ssoData =
  (over: Partial<SsoData> = {}) =>
  (): SsoData => ({
    canManage: true,
    available: true,
    catalog: connections(),
    directories: api<SsoDirectories>("/console/identity/directories"),
    abilities: admin,
    ...over,
  })

const connectData =
  (over: Partial<SsoConnectData> = {}) =>
  (): SsoConnectData => ({
    initial: null,
    catalog: connections(),
    email: "you@acme.dev",
    authOrigin: null,
    previewTest: false,
    ...over,
  })

export const IDENTITY_VIEWS = [
  defineView({
    route: "/settings/security",
    pathname: "/settings/security",
    View: SecurityView,
    shape: securityShape,
    cases: [
      {
        name: "an admin",
        fixture: securityData(),
      },
      {
        name: "owner exemption on, a request to turn it off waiting",
        fixture: securityData({
          exemption: {
            enabled: true,
            pending: {
              requestedBy: "usr_2",
              requestedAt: iso(1),
              expiresAt: iso(-1),
            },
          },
        }),
      },
      {
        name: "a member (cannot manage)",
        fixture: securityData({ abilities: member }),
      },
      {
        name: "not available on this deployment",
        fixture: securityData({ available: false }),
      },
    ],
  }),

  defineView({
    route: "/settings/security/audit",
    pathname: "/settings/security/audit",
    View: SecurityAuditView,
    shape: securityAuditShape,
    cases: [
      {
        name: "events, another page behind them",
        fixture: auditData(),
      },
      {
        name: "no events",
        fixture: auditData({ events: [], nextLimit: null }),
      },
      {
        name: "filtered to a person",
        fixture: auditData({ user: "usr_1" }),
      },
      {
        name: "a member (cannot manage)",
        fixture: auditData({ canManage: false, events: [] }),
      },
    ],
  }),

  defineView({
    route: "/settings/sso",
    pathname: "/settings/sso",
    View: SsoHomeView,
    shape: ssoShape,
    cases: [
      {
        name: "connections and directories",
        fixture: ssoData(),
      },
      {
        name: "nothing set up",
        fixture: ssoData({
          catalog: EMPTY,
          directories: {
            ...api<SsoDirectories>("/console/identity/directories"),
            data: [],
          },
        }),
      },
      {
        name: "a member (cannot manage)",
        fixture: ssoData({ canManage: false, abilities: member, catalog: EMPTY }),
      },
      {
        name: "not available on this deployment",
        fixture: ssoData({ available: false, catalog: EMPTY }),
      },
    ],
  }),

  defineView({
    route: "/settings/sso/connect",
    pathname: "/settings/sso/connect",
    View: SsoConnectView,
    shape: ssoConnectShape,
    cases: [{ name: "choosing a provider", fixture: connectData() }],
  }),

  defineView({
    route: "/settings/sso/[id]",
    pathname: "/settings/sso/x",
    params: { id: "x" },
    View: SsoConnectionPageView,
    shape: ssoConnectionShape,
    cases: connections()
      .data.slice(0, 3)
      .map((connection) => ({
        name: `${connection.provider} ${connection.protocol} (${connection.status})`,
        fixture: (): SsoConnectionData => ({
          connection,
          abilities: admin,
          authOrigin: null,
          clerkEnabled: false,
          mail: {},
        }),
      })),
  }),

  defineView({
    route: "/settings/security/[id]",
    pathname: "/settings/security/x",
    params: { id: "x" },
    View: SsoConnectionPageView,
    shape: ssoConnectionShape,
    cases: connections()
      .data.slice(0, 1)
      .map((connection) => ({
        name: `the redirect draws the connection page (${connection.status})`,
        fixture: (): SsoConnectionData => ({
          connection,
          abilities: admin,
          authOrigin: null,
          clerkEnabled: false,
          mail: {},
        }),
      })),
  }),

  defineView({
    route: "/templates/folder/[id]",
    pathname: "/templates/folder/f1",
    params: { id: "f1" },
    View: (props: { shape: TemplateFolderShape; data?: TemplateFolderData }) => (
      <TemplateFolderView {...props} folderId="f1" />
    ),
    shape: templateFolderShape("f1"),
    cases: [
      {
        name: "empty folder",
        fixture: (tag): TemplateFolderData => ({
          folderId: "f1",
          folder: { ...folder(tag, 0), id: "f1", templates: 0 },
          templates: [],
          folders: [{ ...folder(tag, 0), id: "f1", templates: 0 }],
          view: "grid",
        }),
      },
      {
        name: "templates (grid)",
        fixture: (tag): TemplateFolderData => ({
          folderId: "f1",
          folder: { ...folder(tag, 0), id: "f1" },
          templates: rows(3, (i) => template(tag, i, { folder_id: "f1" })),
          folders: [{ ...folder(tag, 0), id: "f1" }],
          view: "grid",
        }),
      },
      {
        name: "templates (table)",
        fixture: (tag): TemplateFolderData => ({
          folderId: "f1",
          folder: { ...folder(tag, 0), id: "f1" },
          templates: rows(3, (i) => template(tag, i, { folder_id: "f1" })),
          folders: [{ ...folder(tag, 0), id: "f1" }],
          view: "table",
        }),
      },
      {
        name: "subfolders and templates (grid)",
        fixture: (tag): TemplateFolderData => nested(tag, "f1", 0, "grid"),
      },
      {
        name: "subfolders and templates (table)",
        fixture: (tag): TemplateFolderData => nested(tag, "f1", 0, "table"),
      },
      {
        name: "only subfolders (grid)",
        fixture: (tag): TemplateFolderData => ({
          ...nested(tag, "f1", 0, "grid"),
          templates: [],
        }),
      },
      {
        name: "two levels deep (table)",
        fixture: (tag): TemplateFolderData => nested(tag, "f1", 2, "table"),
      },
      {
        name: "six levels deep, the path folded (grid)",
        fixture: (tag): TemplateFolderData => nested(tag, "f1", 5, "grid"),
      },
    ],
  }),
]

/**
 * A folder page with `above` folders over it, two subfolders and three
 * templates inside it. The folders above it are a chain, each inside the last.
 */
function nested(
  tag: string,
  id: string,
  above: number,
  view: "grid" | "table",
): TemplateFolderData {
  const chain = rows(above, (i) => ({
    ...folder(tag, 10 + i),
    id: `up${i}`,
    parent_id: i === 0 ? null : `up${i - 1}`,
    folders: 1,
  }))
  const here = {
    ...folder(tag, 0),
    id,
    parent_id: above === 0 ? null : `up${above - 1}`,
    folders: 2,
  }
  const subs = rows(2, (i) => ({ ...folder(tag, 20 + i), parent_id: id }))
  return {
    folderId: id,
    folder: here,
    templates: rows(3, (i) => template(tag, i, { folder_id: id })),
    folders: [...chain, here, ...subs],
    view,
  }
}

export { iso }
