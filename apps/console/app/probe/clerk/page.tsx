import { notFound } from "next/navigation"
import { ClerkProbe } from "./probe"

export const metadata = { title: "Clerk probe" }

/**
 * A dev-only page for studying Clerk's own organization components:
 * `<OrganizationProfile>` (its Security page) and the self-serve
 * `ConfigureSSO` / `ConfigureDirectorySync` wizards. We never ship these
 * (we own every UI); this is for reading Clerk's flow and its Frontend API
 * calls in the browser. Gone from a production build: `NODE_ENV` folds.
 */
export default function Page() {
  if (process.env.NODE_ENV === "production") notFound()
  return <ClerkProbe />
}
