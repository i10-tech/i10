import type { CSSProperties } from "react"
import { cn } from "cn"
import type { IconName } from "@/lib/site"

/*
 * Pixel icons: 9x9 bitmaps drawn as squares.
 *
 * They are the site's icon language - the same grid the dither fields and the
 * postal barcode motifs sit on - and they animate for free: each pixel carries
 * a delay from its diagonal position, so when a parent `.group` is hovered the
 * icon lights from top-left to bottom-right (Autumn's nav does this with a
 * GSAP timeline; here it is CSS alone, so a hundred icons cost nothing).
 *
 * `#` is ink, anything else is empty. Rows shorter than 9 are padded.
 */
const BITMAPS: Record<IconName, string[]> = {
  send: [
    "#........",
    ".##......",
    ".####....",
    "..#####..",
    "..#######",
    "..#####..",
    ".####....",
    ".##......",
    "#........",
  ],
  mailbox: [
    ".........",
    "#########",
    "##.....##",
    "#.#...#.#",
    "#..#.#..#",
    "#...#...#",
    "#.......#",
    "#########",
    ".........",
  ],
  globe: [
    "...###...",
    ".##.#.##.",
    ".#..#..#.",
    "#########",
    "#...#...#",
    "#########",
    ".#..#..#.",
    ".##.#.##.",
    "...###...",
  ],
  template: [
    "#########",
    "#.......#",
    "#.......#",
    "#########",
    "#..#....#",
    "#..#....#",
    "#..#....#",
    "#########",
    ".........",
  ],
  webhook: [
    "...###...",
    "...#.#...",
    "...###...",
    "....#....",
    "...#.#...",
    "..#...#..",
    "###...###",
    "#.#...#.#",
    "###...###",
  ],
  shield: [
    ".#######.",
    "#.......#",
    "#.....#.#",
    "#....#..#",
    "#.#.#...#",
    "#..#....#",
    ".#.....#.",
    "..#...#..",
    "...###...",
  ],
  inbound: [
    "....#....",
    "....#....",
    "..#.#.#..",
    "...###...",
    "....#....",
    "#.......#",
    "#.......#",
    "#.#####.#",
    "#########",
  ],
  broadcast: [
    ".........",
    ".#.....#.",
    "#..#.#..#",
    "#.#...#.#",
    "#.#.#.#.#",
    "#.#...#.#",
    "#..#.#..#",
    ".#.....#.",
    ".........",
  ],
  book: [
    ".........",
    "####.####",
    "#..#.#..#",
    "#..#.#..#",
    "#..#.#..#",
    "#..#.#..#",
    "####.####",
    "....#....",
    ".........",
  ],
  code: [
    ".........",
    "..##.##..",
    "..#...#..",
    "..#...#..",
    ".##...##.",
    "..#...#..",
    "..#...#..",
    "..##.##..",
    ".........",
  ],
  terminal: [
    ".........",
    "#########",
    "#.......#",
    "#.#.....#",
    "#..#....#",
    "#.#..##.#",
    "#.......#",
    "#########",
    ".........",
  ],
  changelog: [
    ".........",
    "#.######.",
    ".........",
    "#.#####..",
    ".........",
    "#.######.",
    ".........",
    "#.####...",
    ".........",
  ],
  status: [
    ".........",
    "....#....",
    "....#....",
    "...#.#...",
    "#..#.#..#",
    ".##...#.#",
    "......##.",
    ".........",
    ".........",
  ],
  migrate: [
    ".........",
    "......#..",
    "#######.#",
    "......#..",
    ".........",
    "..#......",
    "#.#######",
    "..#......",
    ".........",
  ],
  blog: [
    ".######..",
    ".#....##.",
    ".#.##..#.",
    ".#.....#.",
    ".#.###.#.",
    ".#.....#.",
    ".#.###.#.",
    ".#.....#.",
    ".#######.",
  ],
  brand: [
    ".........",
    "....#....",
    "....#....",
    "...###...",
    ".#######.",
    "...###...",
    "....#....",
    "....#....",
    ".........",
  ],
  people: [
    ".........",
    "..#...#..",
    ".###.###.",
    "..#...#..",
    ".........",
    ".###.###.",
    "#########",
    "#########",
    ".........",
  ],
  key: [
    ".........",
    ".###.....",
    "#...#....",
    "#...#####",
    "#...#.#.#",
    ".###..#.#",
    ".........",
    ".........",
    ".........",
  ],
}

/* Every icon the set has, in drawing order - the design page lists them all. */
export const ICON_NAMES = Object.keys(BITMAPS) as IconName[]

export function PixelIcon({
  name,
  size = 18,
  className,
  style,
}: {
  name: IconName
  size?: number
  className?: string
  style?: CSSProperties
}) {
  const rows = BITMAPS[name]
  const cells: { x: number; y: number }[] = []
  rows.forEach((row, y) => {
    for (let x = 0; x < 9; x++) if (row[x] === "#") cells.push({ x, y })
  })

  return (
    <svg
      viewBox="0 0 9 9"
      width={size}
      height={size}
      aria-hidden
      className={cn("pixel-icon shrink-0", className)}
      style={style}
      shapeRendering="crispEdges"
    >
      {cells.map(({ x, y }) => (
        <rect
          key={`${x}-${y}`}
          x={x + 0.06}
          y={y + 0.06}
          width={0.88}
          height={0.88}
          style={{ "--d": `${(x + y) * 16}ms` } as CSSProperties}
        />
      ))}
    </svg>
  )
}
