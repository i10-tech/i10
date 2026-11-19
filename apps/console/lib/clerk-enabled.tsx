"use client"

import * as React from "react"

/**
 * Whether `<ClerkProvider>` is mounted above this point (app/layout.tsx).
 *
 * ⚠ FOR LOADING VIEWS, WHICH HAVE NO SERVER DATA TO ASK. A loaded page knows
 * from `process.env`; its skeleton renders in the browser before anything
 * arrives, and mounting a panel that calls Clerk's hooks without the provider
 * throws. The default is false, so a tree rendered outside the root layout's
 * providers (the prerendered 404's shell) is treated as having no Clerk.
 */
const ClerkEnabled = React.createContext(false)

export function ClerkEnabledProvider({
  enabled,
  children,
}: {
  enabled: boolean
  children: React.ReactNode
}) {
  return <ClerkEnabled.Provider value={enabled}>{children}</ClerkEnabled.Provider>
}

export const useClerkEnabled = () => React.useContext(ClerkEnabled)
