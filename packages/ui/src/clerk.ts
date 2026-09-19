/**
 * Clerk's components, wearing our colours.
 *
 * ⚠ IT IS ONE OBJECT BECAUSE IT WAS FOUR, AND FOUR WAS THE PROBLEM. The
 * appearance config was repeated inline at every call site — the organization
 * switcher, the user profile, the team panel, the create-organization form —
 * each with its own guess at which Tailwind classes cancelled Clerk's card
 * chrome. They had already drifted: one stripped the border and the shadow, one
 * stripped the padding as well, and none of them touched a single colour. So
 * every Clerk surface rendered in Clerk's palette on a page rendered in ours,
 * which is exactly the "these menus do not fit in" complaint.
 *
 * ⚠ THE VALUES ARE `var(--…)` RATHER THAN LITERAL COLOURS, AND THAT IS WHAT
 * MAKES DARK MODE FREE. Clerk emits every one of these as a `--clerk-*` custom
 * property and derives its shades in CSS with `color-mix()` — so when
 * `next-themes` puts `.dark` on the html element, the browser re-resolves them
 * with no React re-render, no second appearance object, and no flash of the
 * wrong palette. With literal hex values we would have to rebuild this object
 * on every theme change and hand it back to `<ClerkProvider>`, which remounts
 * the Clerk client.
 *
 * ⚠ CLERK'S OWN DOCUMENTATION WARNS AGAINST CSS VARIABLES HERE, AND THE WARNING
 * DOES NOT APPLY TO US. It says to prefer literal colours "for broader browser
 * support", because the derivation needs `color-mix()` (Chrome 111, Firefox
 * 113, Safari 16.2) and relative colour syntax (Chrome 119, Firefox 120, Safari
 * 16.4). Every token below is already an `oklch()` value, which needs Chrome
 * 111 / Firefox 113 / Safari 15.4 — so this console does not render at all in a
 * browser that would struggle with the derivation. The support floor is set by
 * our palette, not by this file.
 *
 * ⚠ AND IT CARRIES NO CLERK TYPES ON PURPOSE. `@repo/ui` is imported by every
 * app including ones with no identity provider; taking a dependency on
 * `@clerk/types` to annotate a plain object would put Clerk in the dependency
 * graph of the marketing site. The shape is structural and the consumer's
 * `appearance` prop checks it.
 */

/**
 * ⚠ THE LAYER NAME MUST MATCH THE `@layer` DECLARATION IN `styles/tokens.css`,
 * and the pair is what makes the `elements` overrides below deterministic.
 * Clerk injects its stylesheet at runtime; CSS puts UNLAYERED rules above every
 * layered one, so without this Clerk's own styles outrank every Tailwind
 * utility we pass in `elements` — and whether an override worked came down to
 * selector specificity, which is why some of them did and some did not.
 * Naming the layer, and declaring it before `utilities`, makes ours win by
 * construction.
 */
export const CLERK_CSS_LAYER = "clerk"

/**
 * The palette, mapped token for token.
 *
 * ⚠ `colorNeutral` IS THE ONE THAT HAS TO FLIP, and `--foreground` is the token
 * that already does. Clerk derives borders, hover fills and dropdown highlights
 * from it, and its own guidance is that light themes need a dark value and dark
 * themes a light one — which is the definition of our foreground colour. A
 * literal 'black' here would make every hover state in dark mode invisible.
 */
const variables = {
  colorPrimary: "var(--primary)",
  colorPrimaryForeground: "var(--primary-foreground)",

  colorForeground: "var(--foreground)",
  colorMutedForeground: "var(--muted-foreground)",
  colorMuted: "var(--muted)",
  colorNeutral: "var(--foreground)",

  /*
   * ⚠ `--popover`, NOT `--background` OR `--card`. Almost everything Clerk
   * renders here is a surface floating over the page — the organization
   * switcher's dropdown, the create-organization dialog, the account menu — and
   * `--popover` is the token our own `DropdownMenu` and `Dialog` use. The
   * panels that sit INLINE on a page have their card chrome stripped by
   * `CLERK_PANEL` below, so they take the page's background regardless and this
   * value never shows through.
   */
  colorBackground: "var(--popover)",

  /*
   * ⚠ NOT `--input`. Our `--input` token is the input's BORDER colour, not its
   * fill — shadcn's convention, and the reason `border-input` appears all over
   * the component library. Passing it here would give Clerk's fields a flat
   * grey fill in light mode, where every one of ours is transparent over the
   * page.
   *
   * ⚠ AND NOT `--background` EITHER, WHICH IS WHAT IT WAS AND WHAT MADE THE
   * VERIFICATION DIALOG UNUSABLE IN DARK MODE. Clerk wants a literal fill where
   * ours are `bg-transparent`, so the nearest honest value is the colour of the
   * surface the field is sitting on — and every Clerk surface that floats is
   * `--popover`, which is what `colorBackground` above is set to. `--background`
   * is PURE BLACK in this palette while `--popover` is 0.14: an input filled
   * with one on a card painted the other is a black rectangle inside a grey
   * one. In light mode both are white, so it looked correct for as long as
   * nobody opened a dialog in the dark.
   */
  colorInput: "var(--popover)",
  colorInputForeground: "var(--foreground)",

  /*
   * ⚠ `--border` IS THE DIVIDER COLOUR, AND CLERK USES THIS FOR FIELDS TOO.
   * Ours are drawn with `--input` (15% in dark mode) and everything else with
   * `--border` (12%); Clerk has one variable for both, so its inputs came out a
   * shade fainter than every input in the product. The `elements` override
   * below puts the right one back on the fields; this stays the divider colour,
   * which is what the rest of Clerk's chrome is.
   */
  colorBorder: "var(--border)",
  colorRing: "var(--ring)",

  colorDanger: "var(--danger)",
  colorSuccess: "var(--success)",
  colorWarning: "var(--warning)",

  fontFamily: "var(--font-sans)",
  fontFamilyMono: "var(--font-mono)",

  /*
   * ⚠ 14px, BECAUSE THE CONSOLE IS A 14px INTERFACE. Clerk defaults to 13px,
   * which is close enough to look like a rendering bug rather than a different
   * size — text in a Clerk panel would sit a hair smaller than the label
   * directly above it.
   */
  fontSize: "0.875rem",
  borderRadius: "var(--radius)",
} as const

/**
 * ⚠ THE SHADOW IS DELIBERATELY NOT MAPPED. There is no shadow token in this
 * design system, and `--foreground` — the obvious candidate — is near-white in
 * dark mode, which would draw a white glow under every Clerk card. Clerk's own
 * default is a neutral black at low opacity and is correct in both themes.
 */

/**
 * Clerk's card chrome, removed.
 *
 * ⚠ IT IS REMOVED RATHER THAN RESTYLED. Clerk's default is a bordered, shadowed
 * card; on a settings page that is already a list of bordered sections, that
 * renders as a box inside a box — and the shadow is the only one anywhere in
 * this console. This is for the panels embedded IN a page, not for the menus,
 * which should keep their surface.
 */
export const CLERK_PANEL = {
  rootBox: "w-full",
  cardBox: "w-full max-w-none border-0 shadow-none",
  card: "w-full max-w-none border-0 bg-transparent p-0 shadow-none",
  pageScrollBox: "p-0",
} as const

/**
 * Clerk's form fields, wearing our input.
 *
 * ⚠ THE VARIABLES ALONE CANNOT DO THIS, WHICH IS WHY IT IS THE ONE `elements`
 * ENTRY ON THE PROVIDER. Clerk has a single `colorBorder` for dividers and
 * fields; our design system deliberately has two (`--border` and `--input`),
 * and the field one is the brighter of them because a field has to announce
 * where it is. There is no variable to say that, so it is said here.
 *
 * ⚠ IT IS ON THE PROVIDER RATHER THAN A COMPONENT BECAUSE THE SURFACE THAT
 * NEEDED IT IS NOT A COMPONENT WE RENDER. The reverification dialog — the one
 * that appears before connecting an account on an instance with two-factor on —
 * is opened by clerk-js itself. There is nothing to pass an appearance to; it
 * inherits this or it inherits nothing, and inheriting nothing was a dialog
 * asking for a code with no visible box to type it in.
 *
 * ⚠ AND `focus-visible:border-ring` IS HOW FOCUS IS SPELLED IN THIS PALETTE.
 * See the note on `--ring` in styles/tokens.css: nothing new is painted, the
 * existing 1px border simply moves from `--input` to `--ring`. A field that
 * borrowed Clerk's own focus treatment would be the only one in either app
 * that grew a halo.
 *
 * ⚠ `bg-transparent` RATHER THAN A COLOUR, so a field is correct on Clerk's
 * floating surfaces AND inside the panels `CLERK_PANEL` strips — which sit on
 * `--card` and `--background`. That is three different colours in dark mode and
 * exactly the reason our own `FloatingInput` paints no fill either.
 */
const CLERK_FIELDS = {
  formFieldInput: "border border-input bg-transparent focus-visible:border-ring",
  otpCodeFieldInput: "border border-input bg-transparent focus-visible:border-ring",
} as const

/**
 * What every app passes to `<ClerkProvider appearance={…}>`.
 *
 * ⚠ SET ON THE PROVIDER, NOT PER COMPONENT, so a Clerk surface added tomorrow
 * inherits it. A component-level appearance is for LAYOUT that is specific to
 * where that component sits — see `CLERK_PANEL` — never for colour.
 */
export const clerkAppearance = {
  /*
   * ⚠ `simple` RATHER THAN THE DEFAULT `clerk` BASE THEME. The default carries
   * Clerk's own brand decisions — gradients, a heavier card, its own focus
   * treatment — which then have to be argued with one `elements` override at a
   * time. `simple` is the unopinionated base the variables above are meant to
   * colour.
   */
  theme: "simple",
  cssLayerName: CLERK_CSS_LAYER,
  variables,
  elements: CLERK_FIELDS,
} as const
