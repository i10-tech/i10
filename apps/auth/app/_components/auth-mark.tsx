import { Mark } from "@repo/ui/components/mark"

/**
 * The i10 mark, pinned exactly where i10.tech's nav draws it.
 *
 * ⚠ THE SAME GEOMETRY AS apps/web/components/site/nav/site-nav.tsx, SO THE
 * LOGO DOES NOT MOVE when somebody presses "Sign in" on the landing page and
 * lands here. Every number below restates one there; change them together:
 *
 *   fixed header, `container-nav`  max-width 1720px, side padding `--nav-pad`
 *                                   (12px, 28px from 48rem, 30px from 80rem)
 *   `pt-3`                          12px from the top
 *   bar `h-[52px] pl-4`             a 52px row, 16px in
 *   link `-ml-2 h-10 px-2`          cancels to 16px, a 40px target
 *   `--logo-h`                      28px tall
 *
 * ⚠ WHITE, NOT THE SITE'S YELLOW (decided 2026-10-01): the text colour, so
 * white on the dark page and black on a light one. The position is what has
 * to carry over.
 *
 * ⚠ A LINK BACK TO THE LANDING PAGE, the same thing pressing it does there.
 */
export function AuthMark() {
  return (
    <header className="pointer-events-none fixed inset-x-0 top-0 z-50">
      <div className="mx-auto w-full max-w-[1720px] px-3 pt-3 md:px-7 xl:px-[30px]">
        <div className="flex h-[52px] items-center pl-4">
          <a
            href="https://i10.tech"
            aria-label="i10 home"
            className="pointer-events-auto -ml-2 flex h-10 items-center rounded-[12px] px-2 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Mark className="h-7 w-auto" shapeRendering="geometricPrecision" />
          </a>
        </div>
      </div>
    </header>
  )
}
