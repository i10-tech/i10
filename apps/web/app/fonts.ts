import { GeistMono } from "geist/font/mono"
import localFont from "next/font/local"

/*
 * The marketing site's type, loaded through next/font so every face gets a
 * metric-matched fallback and the swap moves nothing.
 *
 * ⚠ THE FILES ARE VENDORED IN ./fonts, NOT READ FROM node_modules. Both faces
 * are OFL (licences beside them), and a path into a hoisted node_modules is a
 * property of the install layout rather than of this app - it holds on a laptop
 * and in the Docker build today and breaks the day the linker changes.
 *
 * Inter carries both axes, `opsz` and `wght`. Display sizes set `opsz` 32 in
 * CSS (that IS Inter Display); body text leaves it to the browser's automatic
 * optical sizing.
 */
export const inter = localFont({
  src: [{ path: "./fonts/inter-opsz.woff2", style: "normal", weight: "100 900" }],
  variable: "--font-inter",
  display: "swap",
  adjustFontFallback: "Arial",
})

/*
 * Instrument Serif, italic only. It exists for a word or two inside a
 * headline, never for running text, so the upright cut is not shipped.
 */
export const instrumentSerif = localFont({
  src: [{ path: "./fonts/instrument-serif-italic.woff2", style: "italic", weight: "400" }],
  variable: "--font-instrument",
  display: "swap",
  adjustFontFallback: "Times New Roman",
})

export const geistMono = GeistMono
