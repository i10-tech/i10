import { defineShape } from "@/lib/shapes"
import type { AccessDomain } from "@/lib/actions"
import type { SetupStep } from "@/lib/sso-setup-flow"
import type {
  OidcSetup,
  SamlSetup,
  SsoConnection,
  SsoConnections,
  TestRun,
} from "@/lib/sso-types"

export interface SsoConnectData {
  initial: {
    connection: SsoConnection
    setup: OidcSetup | SamlSetup
    runs: TestRun[]
  } | null
  catalog: SsoConnections
  initialAccessDomains?: {
    data: AccessDomain[]
    verified: string[]
    suggested: string[]
  }
  email: string | null
  authOrigin: string | null
  previewTest: boolean
  error?: string
}

export interface SsoConnectShape {
  step: SetupStep
  hasConnection: boolean
}

const VALID_STEPS = new Set<SetupStep>([
  "provider",
  "connect",
  "domain",
  "test",
  "live",
])

export const ssoConnectShape = defineShape<SsoConnectShape, SsoConnectData>({
  page: "sso-connect",
  fallback: {
    step: "provider",
    hasConnection: false,
  },
  of: (data) => ({
    step: data.initial ? "connect" : "provider",
    hasConnection: data.initial !== null,
  }),
  parse: (raw) => {
    if (typeof raw !== "object" || raw === null) return null
    const r = raw as Record<string, unknown>
    if (typeof r.step !== "string" || !VALID_STEPS.has(r.step as SetupStep)) return null
    return {
      step: r.step as SetupStep,
      hasConnection: r.hasConnection === true,
    }
  },
})
