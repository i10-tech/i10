"use client"

// The folder art is adapted from Rare UI (https://rareui.com/components/foldercomponent),
// MIT + Commons Clause. Its license requires a visible credit linking to
// rareui.com wherever it ships. Changed here: it scales to whatever width it
// is given (every length is a share of the stage), takes the app's light and
// dark tokens instead of a color prop, shows one paper per template up to
// three, and its hover and open states are props the card drives.

import * as React from "react"
import { motion } from "motion/react"
import { cn } from "cn"
import { TemplateSnapshot } from "@/components/template-snapshot"

/** The stage the art is drawn on, in Rare UI's units. Everything below is a share of it. */
const STAGE_W = 321
const STAGE_H = 270
const CARD_W = 164
const CARD_H = 214
const FLAP_H = 241

const FLAP_PATH =
  "M0 25C0 11.1929 11.1929 0 25 0H136.084C143.044 0 149.689 2.90139 154.42 8.00608L178.08 33.5343C182.811 38.639 189.456 41.5404 196.416 41.5404H296C309.807 41.5404 321 52.7333 321 66.5404V216C321 229.807 309.807 241 296 241H25C11.1929 241 0 229.807 0 216V25Z"

const FLAP_STROKE_PATH =
  "M25 0.5H136.084C142.905 0.5 149.417 3.3431 154.054 8.3457L177.713 33.874C182.539 39.0808 189.317 42.04 196.416 42.04H296C309.531 42.04 320.5 53.0092 320.5 66.54V216C320.5 229.531 309.531 240.5 296 240.5H25C11.469 240.5 0.5 229.531 0.5 216V25C0.5 11.469 11.469 0.5 25 0.5Z"

/**
 * The flap's shape as a mask, so the frosted layer under it follows the tab.
 * `clip-path: path()` is in pixels and would not scale with the folder; a mask
 * stretched to the layer's box does.
 */
const FLAP_MASK = `url("data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${STAGE_W} ${FLAP_H}" preserveAspectRatio="none"><path d="${FLAP_PATH}"/></svg>`,
)}")`

const pct = (n: number, of: number) => `${(n / of) * 100}%`

/** Hanging lines of text on a paper, two columns by nine rows. */
const LINES = Array.from({ length: 9 }, (_, row) => 61 + row * 14.12)

/**
 * The three papers, back to front: right, centre, left. Offsets are shares of
 * the paper's own size, so they scale with the folder. `at` is the rest, hover
 * and open pose, and `delay` the stagger Rare UI gives each.
 */
const PAPERS = [
  {
    slot: "right",
    rest: { x: 40, y: -10, r: 10 },
    raised: { x: 40, y: -30, r: 14 },
    over: { x: 55, y: -85, r: 18 },
    delay: { raised: 0.12, over: 0.1 },
  },
  {
    slot: "centre",
    rest: { x: 3, y: -20, r: 2 },
    raised: { x: 3, y: -35, r: -1 },
    over: { x: 3, y: -98, r: -3 },
    delay: { raised: 0.06, over: 0.05 },
  },
  {
    slot: "left",
    rest: { x: -40, y: -22, r: -5 },
    raised: { x: -40, y: -44, r: -9 },
    over: { x: -55, y: -92, r: -14 },
    delay: { raised: 0, over: 0 },
  },
] as const

/** Which papers show for a count: none, the centre one, the outer two, all three. */
function papersFor(count: number) {
  const n = Math.min(Math.max(count, 0), 3)
  if (n === 0) return []
  if (n === 1) return PAPERS.filter((p) => p.slot === "centre")
  if (n === 2) return PAPERS.filter((p) => p.slot !== "centre")
  return PAPERS
}

/** A template in the folder, as the API lists it: enough to fetch its picture. */
export interface FolderPreview {
  id: string
  updated_at: string
}

/**
 * A folder, drawn: a back panel, up to three sheets of paper fanned like a
 * hand for the templates inside, and a frosted front flap with the tab that
 * tilts back as they rise. Adapted from Rare UI's folder.
 *
 * ⚠ THE PAPERS ARE THE COUNT. An empty folder shows none, so "Empty" under
 * it is something the picture already said; one template shows the centre
 * paper, two the outer pair, three or more all of them.
 *
 * ⚠ THE PAPERS CAN BE THE REAL EMAILS. Given `previews` (the folder's newest
 * templates, newest first), each shown paper draws that template's draft as an
 * image (see `PaperPicture`), the newest on the front-most paper. While a picture loads, or if
 * the template has none, the paper keeps its line drawing, so a folder never
 * shows a shimmer or a blank sheet. Without `previews` (the list icon, the
 * empty states) every paper is the drawing.
 *
 * ⚠ IT LIFTS ON HOVER AND WHEN A TEMPLATE IS DRAGGED OVER IT. The papers
 * rising out of the folder is what says "drop it here" without a word, and
 * the same motion on hover says the card opens. The open pose is tuned to
 * stay inside the grid tile (about 36% of the folder's height of room above
 * it): lift it further and the papers are cut off at the tile's edge.
 *
 * ⚠ IT IS FLUID, NOT SIZED. The root takes its width from `className` and
 * every length inside is a share of it (`%` of the stage, `cqw` of the root,
 * SVGs by viewBox), so the first server paint is already right and nothing
 * measures. Do not put a pixel length in here.
 */
export function FolderArt({
  count,
  raised,
  over,
  className,
  previews,
}: {
  count: number
  /** Hovered or focused: the papers peek out. */
  raised: boolean
  /** A template is being dragged over it: the papers rise all the way. */
  over: boolean
  className?: string
  /** The folder's newest templates, newest first. */
  previews?: readonly FolderPreview[]
}) {
  const id = React.useId()
  const pose = over ? "over" : raised ? "raised" : "rest"
  const delayKey = over ? "over" : "raised"
  const shown = papersFor(count)

  return (
    <div
      aria-hidden
      className={cn(
        "@container relative aspect-[321/270] w-[60%] select-none",
        // The one place the two themes differ for the SVG inner shadows,
        // which cannot take a class.
        "[--folder-card-inset:rgb(0_0_0/0.06)] dark:[--folder-card-inset:rgb(255_255_255)]",
        className,
      )}
    >
      {/* Perspective is in cqw of the root, so the tilt has the same depth at any size. */}
      <div
        className="absolute inset-0"
        style={{ perspective: `${(800 / STAGE_W) * 100}cqw` }}
      >
        {/* Back panel. */}
        <div
          className={cn(
            "absolute inset-0 rounded-[7.79cqw] bg-neutral-300",
            "shadow-[inset_0_0_1.87cqw_0.62cqw_rgb(255_255_255/0.55)]",
            "dark:bg-neutral-950 dark:shadow-[inset_0_0_1.87cqw_0.62cqw_rgb(255_255_255/0.37)]",
          )}
        />

        {/* The templates inside. */}
        {shown.map((paper, i) => {
          // The newest template is on the front-most paper: the last one shown.
          const preview = previews?.[shown.length - 1 - i]
          const p = paper[pose]
          return (
            <motion.div
              key={paper.slot}
              initial={false}
              animate={{
                x: pct(p.x, CARD_W),
                y: pct(p.y, CARD_H),
                rotate: p.r,
              }}
              transition={{
                type: "spring",
                stiffness: 120,
                damping: 13,
                delay: pose === "rest" ? 0 : paper.delay[delayKey],
              }}
              className="absolute"
              style={{
                left: pct((STAGE_W - CARD_W) / 2, STAGE_W),
                top: pct((STAGE_H - CARD_H) / 2, STAGE_H),
                width: pct(CARD_W, STAGE_W),
                height: pct(CARD_H, STAGE_H),
              }}
            >
              {preview ? (
                <PaperPicture
                  preview={preview}
                  drawing={<Paper id={`${id}-paper${i}`} />}
                />
              ) : (
                <Paper id={`${id}-paper${i}`} />
              )}
            </motion.div>
          )
        })}

        {/* Front flap: frosted, tilting back as the papers rise. */}
        <motion.div
          initial={false}
          animate={{ rotateX: over ? -55 : raised ? -45 : -15 }}
          transition={{ type: "spring", stiffness: 120, damping: 14 }}
          className="absolute"
          style={{
            left: 0,
            width: "100%",
            top: pct(30.5, STAGE_H),
            height: pct(FLAP_H, STAGE_H),
            transformOrigin: "bottom center",
          }}
        >
          {/* No `preserve-3d`: the flap's children lie flat on it, so the
              tilt only needs the stage's perspective. */}
          <div
            className="absolute inset-0"
            style={{
              backdropFilter: `blur(${(6 / STAGE_W) * 100}cqw)`,
              WebkitBackdropFilter: `blur(${(6 / STAGE_W) * 100}cqw)`,
              maskImage: FLAP_MASK,
              WebkitMaskImage: FLAP_MASK,
              maskSize: "100% 100%",
              WebkitMaskSize: "100% 100%",
              maskRepeat: "no-repeat",
              WebkitMaskRepeat: "no-repeat",
            }}
          />
          <svg
            className="absolute inset-0 size-full"
            viewBox={`0 0 ${STAGE_W} ${FLAP_H}`}
            fill="none"
          >
            <defs>
              <filter
                id={`${id}-flap`}
                x="-25.4"
                y="-25.4"
                width="371.8"
                height="291.8"
                filterUnits="userSpaceOnUse"
                colorInterpolationFilters="sRGB"
              >
                <InnerShadow
                  result={`${id}-flap-shadow`}
                  blur={2.65}
                  color="rgb(0 0 0 / 0.08)"
                />
              </filter>
            </defs>
            <g filter={`url(#${id}-flap)`}>
              <path d={FLAP_PATH} className="fill-white/45 dark:fill-neutral-800/25" />
              <path
                d={FLAP_STROKE_PATH}
                className="stroke-black/10 dark:stroke-neutral-400"
              />
            </g>
          </svg>
        </motion.div>
      </div>
    </div>
  )
}

/**
 * Rare UI's inner shadow: the shape's own alpha, inverted, blurred, tinted and
 * laid back over the shape. The tint is a flood color, which unlike a color
 * matrix can follow the theme.
 */
function InnerShadow({
  result,
  blur,
  color,
  dx = 0,
  dy = 0,
  erode,
}: {
  result: string
  blur: number
  /** A color, or a `var()` the theme sets. */
  color: string
  dx?: number
  dy?: number
  erode?: number
}) {
  return (
    <>
      <feFlood floodOpacity="0" result={`${result}-bg`} />
      <feBlend
        mode="normal"
        in="SourceGraphic"
        in2={`${result}-bg`}
        result={`${result}-shape`}
      />
      <feColorMatrix
        in="SourceAlpha"
        type="matrix"
        values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
        result={`${result}-hard`}
      />
      {erode ? (
        <feMorphology
          radius={erode}
          operator="erode"
          in="SourceAlpha"
          result={`${result}-eroded`}
        />
      ) : null}
      <feOffset dx={dx} dy={dy} />
      <feGaussianBlur stdDeviation={blur} />
      <feComposite
        in2={`${result}-hard`}
        operator="arithmetic"
        k2="-1"
        k3="1"
        result={`${result}-inv`}
      />
      <feFlood style={{ floodColor: color }} result={`${result}-tint`} />
      <feComposite
        in={`${result}-tint`}
        in2={`${result}-inv`}
        operator="in"
        result={`${result}-lit`}
      />
      <feBlend
        mode="normal"
        in={`${result}-lit`}
        in2={`${result}-shape`}
        result={result}
      />
    </>
  )
}

/**
 * A paper showing a template's email, clipped to the sheet's rounded corners
 * (20 on 164 by 214) and edged like the drawing's stroke.
 *
 * ⚠ AN IMAGE, NOT AN IFRAME. The papers move, and on a 4x slowed CPU a grid of
 * 90 iframe papers fell to a median 50ms frame while hovering; images measured
 * the same as the line drawing. The template cards draw the same snapshot.
 */
function PaperPicture({
  preview,
  drawing,
}: {
  preview: FolderPreview
  drawing: React.ReactNode
}) {
  return (
    <div className="relative size-full rounded-[12.2%/9.3%]">
      <TemplateSnapshot
        templateId={preview.id}
        stamp={preview.updated_at}
        fallback={drawing}
        className="rounded-[12.2%/9.3%]"
      />
      <div className="pointer-events-none absolute inset-0 rounded-[12.2%/9.3%] ring-1 ring-neutral-200 ring-inset dark:ring-neutral-300" />
    </div>
  )
}

/** One paper: a rounded sheet with a heading bar and two columns of text lines. */
function Paper({ id }: { id: string }) {
  return (
    <svg
      viewBox={`0 0 ${CARD_W} ${CARD_H}`}
      fill="none"
      className="block size-full overflow-visible"
    >
      <defs>
        <filter
          id={`${id}-fx`}
          x="0"
          y="0"
          width="166.078"
          height="218.262"
          filterUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <InnerShadow
            result={`${id}-shadow`}
            blur={3.05}
            dx={3}
            dy={5}
            erode={2}
            color="var(--folder-card-inset)"
          />
        </filter>
      </defs>
      <g filter={`url(#${id}-fx)`}>
        <rect
          width="163.078"
          height="213.262"
          rx="20"
          className="fill-white dark:fill-neutral-100"
        />
      </g>
      <rect
        x="0.5"
        y="0.5"
        width="162.078"
        height="212.262"
        rx="19.5"
        className="stroke-neutral-200 dark:stroke-neutral-300"
      />
      <rect
        x="14.12"
        y="31.21"
        width="134.84"
        height="11.89"
        rx="5.94"
        className="fill-neutral-300"
      />
      {LINES.map((y) => (
        <React.Fragment key={y}>
          <rect
            x="14.8"
            y={y}
            width="64.52"
            height="5.88"
            rx="2.94"
            className="fill-neutral-300"
          />
          <rect
            x="84.43"
            y={y}
            width="64.52"
            height="5.88"
            rx="2.94"
            className="fill-neutral-300"
          />
        </React.Fragment>
      ))}
    </svg>
  )
}

/**
 * The folder at icon size, for breadcrumbs and menus: the same tab and
 * two-tone panels, without the papers or the motion.
 */
export function FolderGlyph({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 20 16"
      className={cn("size-4 text-foreground", className)}
    >
      <path
        d="M1 3.2A2.2 2.2 0 0 1 3.2 1h4.1a1.6 1.6 0 0 1 1.3.7l.8 1.1a1 1 0 0 0 .8.4h6.6A2.2 2.2 0 0 1 19 5.4v8.4a2.2 2.2 0 0 1-2.2 2.2H3.2A2.2 2.2 0 0 1 1 13.8z"
        fill="currentColor"
        fillOpacity="0.28"
      />
      <rect
        x="1"
        y="6"
        width="18"
        height="10"
        rx="2.2"
        fill="currentColor"
        fillOpacity="0.55"
      />
    </svg>
  )
}
