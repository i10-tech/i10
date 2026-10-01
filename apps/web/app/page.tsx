import { ChangelogTeaser } from "@/components/home/changelog-teaser"
import { Closing } from "@/components/home/closing"
import { ConsoleTeaser } from "@/components/home/console-teaser"
import { Domains } from "@/components/home/domains"
import { Frameworks } from "@/components/home/frameworks"
import { Hero } from "@/components/home/hero"
import { Integrate } from "@/components/home/integrate"
import { Manifesto } from "@/components/home/manifesto"
import { Primitives } from "@/components/home/primitives"
import { Principles } from "@/components/home/principles"
import { ProductRail } from "@/components/home/product-rail"
import { Security } from "@/components/home/security"
import { WorksWith } from "@/components/home/works-with"

/*
 * The home page, top to bottom: what it is (hero), what it looks like (the
 * console, playing), what it works with, what it believes (FIG 0.1-0.3), what
 * it is for (the manifesto), how you use it (integrate, domains), everything
 * it does (the rail), how it works inside (primitives, frameworks, security),
 * that it ships (changelog), and the ask.
 */
export default function Page() {
  return (
    <>
      <Hero />
      <ConsoleTeaser />
      <WorksWith />
      <Principles />
      <Manifesto />
      <Integrate />
      <Domains />
      <ProductRail />
      <Primitives />
      <Frameworks />
      <Security />
      <ChangelogTeaser />
      <Closing />
    </>
  )
}
