import { redirect } from "next/navigation"

/**
 * ⚠ THE ROOT IS NOT A PAGE. Nobody types auth.i10.tech on purpose — they arrive
 * from a link that already names a flow. Sending them to sign-in is the only
 * useful answer; rendering a landing page here would be a second front door to
 * maintain for an audience of accidents.
 */
export default function Page() {
  redirect("/sign-in")
}
