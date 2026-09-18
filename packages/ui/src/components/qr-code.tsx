"use client"

import * as React from "react"
import { renderSVG } from "uqr"
import { cn } from "cn"

/**
 * A QR code, drawn in the browser and nowhere else.
 *
 * ⚠ IT IS A CLIENT COMPONENT BECAUSE THE THING IT ENCODES MUST NOT REACH A
 * SERVER, AND THAT IS THE WHOLE REASON THIS FILE EXISTS RATHER THAN AN <img>
 * POINTING AT A QR SERVICE. The first use is a TOTP enrolment URI, which
 * contains the shared secret in plaintext — `otpauth://totp/…?secret=…`. Handing
 * that to api.qrserver.com or chart.googleapis.com hands a third party the seed
 * for every two-factor code the account will ever produce, permanently, for a
 * picture. Encoding it locally means the secret exists in exactly two places:
 * Clerk, and the phone it is being scanned onto.
 *
 * ⚠ AND IT IS SVG RATHER THAN CANVAS. A canvas has to be sized in device pixels
 * to avoid a soft QR on a retina screen, redrawn on every DPI change, and is
 * invisible to `prefers-color-scheme` — where an SVG is vector, scales to
 * whatever box it is given, and takes `currentColor` so the same markup is
 * correct on a black canvas and a white one. A QR scanner needs contrast and
 * sharp module edges; those are the two things SVG gives for free.
 *
 * ⚠ THE LIGHT MODULES ARE `transparent`, NOT WHITE. This is drawn on `--card`
 * in dark mode, and a white quiet zone would be a white square with a black
 * code in it sitting on a black page — which scans fine and looks like a bug.
 * The caller supplies the background; see the `bg-*` on the wrapper below.
 */
export function QrCode({
  value,
  className,
  title,
}: {
  /** What the code encodes. */
  value: string
  className?: string
  /** What a screen reader calls it. The VALUE is never announced. */
  title: string
}) {
  /*
   * ⚠ MEMOISED ON `value`, BECAUSE ENCODING IS NOT FREE. `renderSVG` runs
   * Reed-Solomon error correction and mask evaluation — eight candidate masks,
   * each scored across the whole matrix. At ~150 modules square that is real
   * work to repeat on every parent re-render, and the parent here is a form
   * with a six-digit code box in it that re-renders on every keystroke.
   */
  const svg = React.useMemo(
    () =>
      renderSVG(value, {
        // ⚠ `border` IS THE QUIET ZONE, AND 2 IS THE SPEC'S MINIMUM VIABLE. The
        // QR standard asks for 4 modules of clear space; scanners in practice
        // manage with 2, and the wrapper below adds real padding on top of it.
        // Zero is what makes a code that reads on one phone and not another.
        border: 2,
        pixelSize: 1,
        whiteColor: "transparent",
        blackColor: "currentColor",
      }),
    [value],
  )

  return (
    <div
      role="img"
      aria-label={title}
      className={cn(
        "size-44 rounded-xl bg-background p-3 text-foreground [&>svg]:size-full",
        className,
      )}
      /*
       * ⚠ `dangerouslySetInnerHTML` ON LOCALLY-GENERATED MARKUP, WHICH IS THE
       * ONE CASE IT IS FOR. `renderSVG` emits a fixed grammar — one <svg>, one
       * <rect>, one <path> of `M…h…v…` — built from a bit matrix, not from
       * `value`. The input is encoded into modules; it is never interpolated
       * into the markup, so there is no string from the caller that can reach
       * the DOM as anything other than black and white squares.
       */
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}
