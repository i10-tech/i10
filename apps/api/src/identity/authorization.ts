import type { Connection, ConnectionStatus, Enforcement } from "./model.js"

export type ConnectionWritePatch = {
  status?: ConnectionStatus
  enforcement?: Enforcement
}

/**
 * Setup writes are low risk until a connection is live. Lifecycle changes and
 * required enforcement remain protected even while the connection is in setup.
 */
export function connectionWriteNeedsFreshAuth(
  connection: Pick<Connection, "status" | "enforcement">,
  patch: ConnectionWritePatch = {},
): boolean {
  return (
    connection.status === "active" ||
    connection.status === "disabled" ||
    patch.status === "active" ||
    patch.enforcement === "required_domain" ||
    patch.enforcement === "required_all"
  )
}
