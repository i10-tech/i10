import type { SVGProps } from "react"

/*
 * The i10 mark: a slanted, heavy ligature of "i", "1" and "0".
 *
 * Drawn upright on a 100-unit cap height and sheared -10 degrees as a whole,
 * so every counter and joint shares one angle. The "1" carries its flag as a
 * chamfer rather than a separate stroke; at nav size a flag reads as noise and
 * a chamfer still reads as a 1. The dot of the i is square, like the stems.
 *
 * ⚠ THE VIEWBOX IS THE SHEARED BOUNDING BOX, NOT 0 0 144 100. The shear moves
 * the baseline 17.63 units left (tan 10deg x 100), so a naive viewBox clips the
 * foot of the i. Rightmost ink is the 0's flank at y=36: 144 - 0.1763 x 36.
 */
export const MARK_VIEWBOX = "-17.7 0 155.4 100"
export const MARK_ASPECT = 155.4 / 100

export const MARK_PATH = [
  "M0 0h24v22H0z",
  "M0 32h24v68H0z",
  "M36 18 54 0h6v100H36z",
  "M72 36a36 36 0 0 1 72 0v28a36 36 0 0 1-72 0z",
  "M96 38a12 12 0 0 1 24 0v24a12 12 0 0 1-24 0z",
].join("")

export function Mark({
  title = "i10",
  ...props
}: SVGProps<SVGSVGElement> & { title?: string }) {
  return (
    <svg
      viewBox={MARK_VIEWBOX}
      fill="currentColor"
      role="img"
      aria-label={title}
      {...props}
    >
      <path transform="skewX(-10)" fillRule="evenodd" d={MARK_PATH} />
    </svg>
  )
}

/*
 * The same shape as a CSS mask image, for the footer's masked mark: content
 * shows only through the glyph. Built from the constants above so the mask
 * and the SVG can never disagree.
 */
export const markMaskUrl = `url("data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' viewBox='${MARK_VIEWBOX}'><path transform='skewX(-10)' fill-rule='evenodd' d='${MARK_PATH}'/></svg>`,
)}")`
