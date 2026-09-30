"use client"

import { useGSAP } from "@gsap/react"
import gsap from "gsap"
import { CustomEase } from "gsap/CustomEase"
import { DrawSVGPlugin } from "gsap/DrawSVGPlugin"
import { ScrambleTextPlugin } from "gsap/ScrambleTextPlugin"
import { ScrollTrigger } from "gsap/ScrollTrigger"
import { SplitText } from "gsap/SplitText"

/*
 * GSAP, registered once for the whole site. Every animation imports from here
 * rather than from "gsap" directly, so a plugin is never used before it is
 * registered and the site's curves exist under one set of names.
 *
 * The named eases mirror the CSS custom properties in globals.css, so a CSS
 * transition and a GSAP tween on the same page move with the same shape.
 */
let registered = false

if (typeof window !== "undefined" && !registered) {
  gsap.registerPlugin(ScrollTrigger, SplitText, ScrambleTextPlugin, DrawSVGPlugin, CustomEase, useGSAP)
  CustomEase.create("site.out", "0.16, 1, 0.3, 1")
  CustomEase.create("site.quint", "0.22, 1, 0.36, 1")
  CustomEase.create("site.inOut", "0.77, 0, 0.175, 1")
  gsap.defaults({ ease: "site.out", duration: 0.9 })
  ScrollTrigger.config({ ignoreMobileResize: true })
  registered = true
}

export const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches

export { gsap, ScrollTrigger, SplitText, useGSAP }
