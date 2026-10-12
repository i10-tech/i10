import localFont from "next/font/local"

/*
 * Arc's body face. Geist (display) and Geist Mono come from the `geist`
 * package; Inter is vendored beside this file, as on the marketing site, so
 * the build never depends on the install layout. OFL, licence alongside.
 */
export const inter = localFont({
  src: [{ path: "./fonts/inter-opsz.woff2", style: "normal", weight: "100 900" }],
  variable: "--font-inter",
  display: "swap",
  adjustFontFallback: "Arial",
})
