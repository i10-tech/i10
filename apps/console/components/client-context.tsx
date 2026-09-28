"use client"

import { useEffect } from "react"

/**
 * Collects the two things only the browser knows - its timezone and a device
 * id - into the first-party `i10_ctx` cookie, for the risk engine (#170).
 *
 * ⚠ SECURITY, NOT ANALYTICS, AND ONLY FOR SIGNED-IN USE. It exists to spot one
 * device behind many accounts and a sign-in that contradicts the last; it is
 * mounted only inside the signed-in console, it is never sent to anybody but
 * our own API, and it is named in the privacy policy (docs/decisions/risk.md,
 * #219).
 *
 * ⚠ FINGERPRINTJS IS LOADED LAZILY AND ITS FAILURE IS SILENT. A blocked script
 * or an old browser costs the risk engine a signal, never the page.
 */
export function ClientContext() {
  useEffect(() => {
    let cancelled = false
    const write = (value: Record<string, string>) => {
      if (cancelled) return
      const secure = window.location.protocol === "https:" ? "; Secure" : ""
      document.cookie = `i10_ctx=${encodeURIComponent(JSON.stringify(value))}; Path=/; Max-Age=2592000; SameSite=Lax${secure}`
    }
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? ""
    const lang = navigator.language ?? ""
    import("@fingerprintjs/fingerprintjs")
      .then((m) => m.default.load())
      .then((agent) => agent.get())
      .then((result) => write({ tz, lang, device: result.visitorId }))
      .catch(() => write({ tz, lang }))
    return () => {
      cancelled = true
    }
  }, [])
  return null
}
