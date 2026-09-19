import { cn } from "cn"

/**
 * A DNS provider's mark, for the "Connect" button.
 *
 * ⚠ THESE ARE SIMPLIFIED MONOCHROME GLYPHS DRAWN FROM EACH BRAND'S SILHOUETTE,
 * NOT THE OFFICIAL LOGOS, AND THAT IS A DELIBERATE CHOICE RATHER THAN A
 * SHORTCUT. Shipping a vendor's actual logo asset means shipping their
 * trademark, their colour, and their file — which changes without telling us —
 * into a product that competes with some of them. A recognisable single-colour
 * mark does the only job the logo has here (you spot your provider in half a
 * second) while staying ours to change.
 *
 * ⚠ AND A REDRAWN MARK IS NEVER GIVEN THE BRAND'S COLOUR. There was a map of
 * brand hexes here and it has gone, because colouring an approximation is the
 * worst of both: it claims to be the vendor's mark precisely where it is least
 * entitled to. Colour arrives only with an official asset, in `OFFICIAL` above,
 * which carries its own fills. Everything else stays in `currentColor`.
 *
 * ⚠ AND EVERY ONE OF THEM USES `currentColor`, WHICH IS ALSO THE ANSWER TO
 * "DOES IT WORK IN DARK AND LIGHT MODE". A mark that inherits the text colour
 * works in both by construction — there is no second asset, no pair to keep in
 * step, and no provider that needs one. Real brand assets would need exactly
 * that: two files each, forty-five times, every one of them reviewed again
 * whenever a vendor refreshes their brand.
 *
 * ⚠ THE COLOUR ARGUMENT IS THE OTHER HALF. On a true-black canvas a
 * brand-coloured logo is the only saturated thing on the page and drags the eye
 * straight to it; worse, several of these brands are blue, which would be the
 * accent this design system deliberately does not have. Following the text
 * colour keeps the mark subordinate to the sentence it sits in.
 *
 * ⚠ THE FALLBACK IS A MONOGRAM, NOT A GENERIC GLOBE. There are forty-odd
 * providers in the registry and a handful of marks here; a globe for the other
 * thirty makes them look unsupported, when in fact delegation works identically
 * for all of them. Two letters in a bordered tile reads as "yes, that one".
 */

/**
 * Official marks, used EXACTLY as the vendor publishes them.
 *
 * ⚠ THESE ARE NOT REDRAWN AND MUST NEVER BE. Cloudflare's trademark policy is
 * explicit — "You may not modify Cloudflare trademarks, abbreviate them, or
 * combine them with any other symbols, words, or images", and their web badges
 * must not be altered "(e.g., stretched out, different colors, etc)". A
 * simplified silhouette in their orange, which is what this file carried
 * before, is a MODIFIED mark: the most exposed of the available options while
 * looking like the most careful one.
 *
 * ⚠ SO ANYTHING ADDED HERE IS COPIED FROM THE VENDOR'S OWN ASSET, fills and
 * all, and the `viewBox` is theirs. Nothing in this file recolours one, and the
 * monochrome `PATHS` below are for providers we do NOT have an official asset
 * for — they are approximations and are drawn as such, in `currentColor`,
 * without claiming a brand colour they are not entitled to.
 *
 * ⚠ THE PROPORTIONS ARE THE VENDOR'S TOO. Cloudflare's mark is roughly 1.7:1,
 * so it is given its own `viewBox` and left to letterbox inside a square slot
 * rather than being squashed into one. Stretching it is the specific thing the
 * badge rule names.
 */
const OFFICIAL: Record<
  string,
  { viewBox: string; paths: { d: string; fill: string }[] }
> = {
  cloudflare: {
    viewBox: "0 0 460 271.2",
    paths: [
      {
        fill: "#FF9911",
        d: "M328.6,125.6c-0.8,0-1.5,0.6-1.8,1.4l-4.8,16.7c-2.1,7.2-1.3,13.8,2.2,18.7c3.2,4.5,8.6,7.1,15.1,7.4l26.2,1.6c0.8,0,1.5,0.4,1.9,1c0.4,0.6,0.5,1.5,0.3,2.2c-0.4,1.2-1.6,2.1-2.9,2.2l-27.3,1.6c-14.8,0.7-30.7,12.6-36.3,27.2l-2,5.1c-0.4,1,0.3,2,1.4,2h93.8c1.1,0,2.1-0.7,2.4-1.8c1.6-5.8,2.5-11.9,2.5-18.2c0-37-30.2-67.2-67.3-67.2C330.9,125.5,329.7,125.5,328.6,125.6z",
      },
      {
        fill: "#FF5E1F",
        d: "M292.8,204.4c2.1-7.2,1.3-13.8-2.2-18.7c-3.2-4.5-8.6-7.1-15.1-7.4l-123.1-1.6c-0.8,0-1.5-0.4-1.9-1s-0.5-1.4-0.3-2.2c0.4-1.2,1.6-2.1,2.9-2.2l124.2-1.6c14.7-0.7,30.7-12.6,36.3-27.2l7.1-18.5c0.3-0.8,0.4-1.6,0.2-2.4c-8-36.2-40.3-63.2-78.9-63.2c-35.6,0-65.8,23-76.6,54.9c-7-5.2-15.9-8-25.5-7.1c-17.1,1.7-30.8,15.4-32.5,32.5c-0.4,4.4-0.1,8.7,0.9,12.7c-27.9,0.8-50.2,23.6-50.2,51.7c0,2.5,0.2,5,0.5,7.5c0.2,1.2,1.2,2.1,2.4,2.1h227.2c1.3,0,2.5-0.9,2.9-2.2L292.8,204.4z",
      },
    ],
  },
}

const PATHS: Record<string, string> = {
  /* Amazon Route 53 — a simplified smile. */
  route53:
    "M4 15.5c2.8 1.9 6.2 2.9 9.7 2.9 2.4 0 5-.5 7.4-1.5.4-.2.7.2.4.5-2.1 1.9-5.2 2.9-7.9 2.9a14.3 14.3 0 0 1-9.7-3.7c-.3-.2 0-.6.1-.6z M17 14.4c-.3-.4.3-.6.5-.3.4.5.4 2.4.1 3.1-.2.4-.5.1-.4-.1.2-.7.4-2.3-.2-2.7z M9.6 5.4c0-.2.1-.3.3-.3h4.7c.2 0 .3.1.3.3v1.1c0 .2-.1.4-.3.6l-2.5 3.5c.9 0 1.9.1 2.7.6.2.1.3.3.3.4v1.2c0 .2-.2.4-.4.3a5.5 5.5 0 0 0-5 0c-.2.1-.4-.1-.4-.3v-1.1c0-.2 0-.5.2-.8l2.8-4H9.9c-.2 0-.3-.1-.3-.3z",
  /* DigitalOcean — the O. */
  digitalocean:
    "M12 21v-4.1c4.3 0 7.7-4.3 6-8.9a6.9 6.9 0 0 0-4-4c-4.5-1.6-8.8 1.7-8.8 6h-4C1.2 3.1 7.9-1.4 15.2.9c3.2 1 5.8 3.6 6.8 6.8C24.3 15 19.8 21 12 21z M12 16.9H7.9V12.8H12z M7.9 20.1H4.7v-3.2h3.2z M4.7 16.9H2.1v-2.7h2.6z",
  /* GoDaddy — the GO monogram is their actual mark shape. */
  godaddy:
    "M20.9 5.6a7.4 7.4 0 0 0-9 .4 7.4 7.4 0 0 0-9-.4 7.4 7.4 0 0 0-.4 9c1 1.5 2.7 2.4 4.5 2.6v2.4c0 .4.3.7.7.7h1.6c.4 0 .7-.3.7-.7v-2.4c1-.1 2-.5 2.9-1.1.9.6 1.9 1 2.9 1.1v2.4c0 .4.3.7.7.7h1.6c.4 0 .7-.3.7-.7v-2.4c1.8-.2 3.5-1.1 4.5-2.6a7.4 7.4 0 0 0-.4-9zM6.4 14.8a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm11.2 0a4 4 0 1 1 0-8 4 4 0 0 1 0 8z",
  /* Vercel — the triangle. */
  vercel: "M12 2 22.5 20.5h-21z",
  /* Netlify — the diamond. */
  netlify:
    "M12 1.6 2.4 11.2a1.1 1.1 0 0 0 0 1.6L12 22.4l9.6-9.6a1.1 1.1 0 0 0 0-1.6zm0 3.2 6.4 6.4L12 17.6 5.6 11.2z",
  /* Namecheap — the chevron pair. */
  namecheap:
    "M3 6.5c0-.6.6-1 1.1-.7l6.4 3.8c.3.2.5.5.5.9v6.1c0 .6-.6 1-1.1.7L3.5 13.5a1 1 0 0 1-.5-.9zm11 4c0-.4.2-.7.5-.9l6.4-3.8c.5-.3 1.1.1 1.1.7v6.1c0 .4-.2.7-.5.9l-6.4 3.8c-.5.3-1.1-.1-1.1-.7z",
  /* Azure — the two chevrons of the A. */
  "azure-dns":
    "M9.6 3.4h5.2l-5.4 16 -6.4 0 6.6-16zm1.6 4.6 4 11.4H5.5l6-2.5.6-.2-3.4-4 2.5-4.7z",
  /* Linode — the angular L. */
  linode:
    "M11 2.3 5.5 5.6v6.2l2.6 1.5V7.1L11 5.4zm0 7.4-2.9 1.7v6.2L11 19.3v-6.2l2.9-1.7V5.2L11 6.9zm3.1 1.8v6.2l-2.6 1.5v-6.2z",
  /* Hetzner — the rungs of the H. */
  hetzner: "M4 4h3.4v6.2h9.2V4H20v16h-3.4v-6.4H7.4V20H4z",
  /* DNSimple — a simple monolith with a notch. */
  dnsimple:
    "M12 2 3 6.6v10.8L12 22l9-4.6V6.6zm0 3 6 3v8l-6 3-6-3V8zm-2 3.6v6.8l4-2v-2.8l-2 1V9.6z",
  /* Squarespace — the interlocking frames. */
  squarespace:
    "M6.6 8.4a3.4 3.4 0 0 1 4.8 0l5 5-1.7 1.7-5-5a1 1 0 0 0-1.4 0l-3.9 3.9a1 1 0 0 0 0 1.4l1.6 1.7-1.7 1.7-1.7-1.7a3.4 3.4 0 0 1 0-4.8zm10.8 7.2a3.4 3.4 0 0 1-4.8 0l-5-5 1.7-1.7 5 5a1 1 0 0 0 1.4 0l3.9-3.9a1 1 0 0 0 0-1.4l-1.6-1.7 1.7-1.7 1.7 1.7a3.4 3.4 0 0 1 0 4.8z",
  /* Shopify — the bag. */
  shopify:
    "M14.6 4.6c-.2-.5-.7-.8-1.2-.8-1.7 0-3.1 1.5-3.7 3.6l-2 .6c-.6.2-.6.2-.7.8L5.4 20.2l8.5 1.6 4-1V5.2c0-.3-.2-.5-.5-.5zm-2.8 2.1-1.8.5c.4-1.3 1.2-2.2 2-2.4-.1.5-.2 1.2-.2 1.9zm.6 3.9c-.5-.2-1-.3-1.4-.3-1.3 0-1.3.8-1.3 1 0 1.1 2.9 1.6 2.9 4.2 0 2.1-1.3 3.4-3.1 3.4-2.1 0-3.2-1.3-3.2-1.3l.6-1.9s1.1 1 2 1c.6 0 .9-.5.9-.9 0-1.5-2.4-1.5-2.4-3.9 0-2 1.5-4 4.4-4 1.1 0 1.7.3 1.7.3z",
  /* Google Cloud DNS — the four-part mark, simplified. */
  "google-cloud-dns":
    "M12 2.2 4.2 6.7v9l7.8 4.5 7.8-4.5v-9zm0 2.3 5.8 3.4L12 11.2 6.2 7.9zM5.9 9.8 11 12.8v6L5.9 15.8zm7.1 3 5.1-3v6l-5.1 3z",
}

/** For the monogram fallback: the two most distinctive letters. */
function monogram(name: string): string {
  const words = name.split(/[\s.]+/).filter(Boolean)
  if (words.length >= 2) {
    return `${words[0]![0] ?? ""}${words[1]![0] ?? ""}`.toUpperCase()
  }
  return (name.slice(0, 2) || "?").toUpperCase()
}

export function ProviderMark({
  slug,
  name,
  className,
}: {
  slug: string
  name: string
  className?: string
}) {
  /*
   * ⚠ THE OFFICIAL ASSET WINS WHEREVER WE HAVE ONE, and it is not gated on the
   * `brand` prop. A vendor's real mark is the correct thing to show in every
   * position — the prop decides whether a SURFACE wants brand treatment, not
   * whether a trademark may be recoloured.
   */
  const official = OFFICIAL[slug]
  const path = PATHS[slug]

  if (official) {
    return (
      <svg
        viewBox={official.viewBox}
        aria-hidden="true"
        /*
         * ⚠ A SQUARE SLOT AND A WIDE MARK, LEFT TO LETTERBOX. The default
         * `preserveAspectRatio` fits it inside without distorting, which is what
         * the badge rule demands — so the size class controls the BOX and the
         * mark keeps its own 1.7:1.
         *
         * ⚠ AND IT IS `size-*` DELIBERATELY. The button's base style forces
         * `size-4` onto any svg whose class list does not already contain
         * "size-", so an `h-4 w-auto` here was silently overridden into a 16px
         * box — giving a mark 9px tall next to 14px text.
         */
        className={cn("size-7 shrink-0", className)}
      >
        {official.paths.map((part) => (
          <path key={part.d.slice(0, 24)} d={part.d} fill={part.fill} />
        ))}
      </svg>
    )
  }

  if (path) {
    return (
      <svg
        viewBox="0 0 24 24"
        // ⚠ AN INLINE COLOUR RATHER THAN A CLASS, because the value comes from
        // a data map keyed on a slug — a Tailwind class built from a template
        // string is invisible to the scanner and would simply not exist in the
        // stylesheet.
        // ⚠ `aria-hidden` AND NO <title>. The provider's name is always
        // rendered as text beside this; a labelled icon would make a screen
        // reader announce "Cloudflare Cloudflare".
        aria-hidden="true"
        fill="currentColor"
        className={cn("size-4 shrink-0", className)}
      >
        <path d={path} />
      </svg>
    )
  }

  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid size-4 shrink-0 place-items-center rounded-[3px] border text-[7px] leading-none font-semibold",
        className,
      )}
    >
      {monogram(name)}
    </span>
  )
}
