# Skeletons

How every console page looks while it loads, and how it turns into the page.
Written before the code (2026-11-05) so the shape is arguable apart from the
diff. The reference for the motion is Arc's skeleton morph
(uiarc.dev/components/skeleton-morph) and a 60fps recording of it, analysed
frame by frame below.

---

## 1. The bar

A skeleton is right only if it is right every time: the first visit, every
data state (none, one, two, many), every conditional piece (a button that
only shows with rows, a banner that only shows with offers), and after any
future edit to the page. A skeleton that gets better the more often you visit
is wrong on the visits that matter.

## 2. What was there, and why it drifts

Each route had a hand-written `loading.tsx` built from `components/skeletons`:
the page's real header and column heads, with bars of guessed widths for the
data. Two copies of every page, kept in step by hand. Domains shows the cost:
its skeleton always drew two header buttons, while the page hides "Add domain"
when the list is empty, and it never drew the incoming-transfers banner. Only
the row count was remembered (a cookie, `i10-count-*`), and only after a
visit. About 25 pages had no skeleton of their own and fell back to one
generic box.

## 3. Decision: one view, two modes

**Every page's body is a view component that renders both its loaded state
and its skeleton.** The skeleton is not drawn to look like the page; it is the
page, with `loading` set.

- Static copy (titles, descriptions, column heads, field labels, button
  labels that do not depend on data) renders as real text in both modes.
- Every data-bearing piece is wrapped in a `Bone`. Loading, the bone draws a
  bar that fills the exact box the content will occupy; loaded, it renders the
  content.
- `loading.tsx` renders the same view with no data. It cannot drift from the
  page because there is nothing separate to drift.

Rejected: recording the page's last layout and replaying it. It is exact only
from the second visit, which is the behaviour this replaces.

## 4. Shape: the one thing a skeleton cannot know

Without data, a view cannot know how much data there is, or whether the
pieces that depend on it show. That is the page's **shape**: a small,
serialisable value derived from the data, for example
`{ rows: 2, transfers: 0 }`.

- The view's structural decisions are a function of the shape alone. Loaded,
  the page passes `shapeOf(data)`; loading, it passes the remembered shape.
  The types make it impossible to branch on data where the shape should
  decide.
- The shape is remembered per workspace in a cookie (`i10-shape-<page>`,
  replacing `i10-count-*`), so the server renders the same skeleton the
  client would.
- **First visit:** when the console loads, the app layout asks the API for
  every list's shape in one call (`GET /console/shapes`: counts and flags,
  cheap `count(*)` queries under the tenant's RLS). So the skeleton is exact
  before a page has ever been opened on this device.
- Record pages (`/domains/[id]`, ...) take their shape from the list row the
  user clicked, stashed before navigation. A cold deep link uses the default
  shape.
- When the data changed in between, the morph absorbs the difference (§5).

## 5. Motion, from the recording

Measured from the 60fps reference (8s, two cards, reload at 0.2s, resolve at
1.78s):

- **Into loading: instant.** Content to skeleton in one frame, no fade. A
  fast reload never leaves a block halfway.
- **While loading:** a shimmer, one band of light crossing the page in
  about 1.4s, then resting 1s (2026-11-18). The reference pulses opacity
  (measured: bars 36 to 31 over a card of 24, uniform, no sweep); the user
  asked for a shimmer. Each bar's band is laid from the viewport's left edge
  and every bar runs on the page's clock, so all bars show one band, in step
  across remounts. It moves by `transform` only, so the compositor keeps it
  moving while the main thread commits the page (components/shimmer).
  Controls that act on the data (Reload) dim.
- **Bars:** text bars are pills, about 60% of the line height, centred in the
  line box and as wide as the line box (wider than the text). Of several
  lines, the last is shorter. Avatars are circles, buttons are their own pill.
- **Resolve, per block:** the bar stretches from its skeleton box to the
  content's measured box on a critically damped spring and fades, while the
  content sharpens from `blur(4px)` and opacity 0, over about 200 to 250ms.
  Blocks change in place and never travel.
- **Order:** reading order, about 40ms apart. Separate panels (the two cards)
  run their sequences at the same time. A long list staggers by row, and the
  whole spread is capped (about 320ms) so a ten-row table does not take two
  seconds.
- **Across, to the ink** (2026-11-18): a bar stretches to what its content
  draws (text, icons, filled pills, a checkbox's square), not to the content's
  block, which is as wide as its column. Content that draws nothing (an empty
  optional line) fades in place.
- **Cards side by side resolve together**, like the reference's two panels;
  grid rows step, as table rows do.
- **Tables do not move:** every list table has a fixed layout, so the header's
  widths are the columns with bars in them and with values. An inset bone
  (the checkbox) holds its whole hit area, not only its square.
- **Height:** the region eases to its new height and clips only while it
  moves, so borders and the content below never jump.
- **Mismatch:** a bar with no content to become (one row fewer than
  remembered) fades in place; content with no bar (a new row) sharpens in
  from its own box.
- **Reduced motion:** no shimmer, no stretch, a short crossfade.

## 6. Mechanics

- `Bone` and `BoneScope` live in `packages/ui`. `Bone` takes `id`, `lines`,
  `lineHeight`, `width`, `radius`, `as`.
- **Across the route swap.** `loading.tsx` and the page are different
  instances, so a bone cannot keep its own DOM. Skeleton bones register their
  rect by `id` (scoped by `BoneScope`) and, on unmount, leave it in a short
  lived departing map. A content bone mounting in the same commit claims its
  id's rect and morphs from it. Unclaimed rects are painted by a body portal
  and faded. A content bone with nothing to claim, and no skeleton shown at
  all (a router cache hit), renders without animation.
- **In place.** A client panel that loads its own data uses the same bone
  with `loading` toggled; it morphs from its own skeleton geometry.
- **Known gap:** on a hard reload, if the page streams in before hydration,
  React swaps the boundary with its inline script and the swap is a cut.

## 7. Guarding it

A check fails any `page.tsx` under `app/(app)` without a `loading.tsx` that
renders its view, so a new page cannot ship without a skeleton.
