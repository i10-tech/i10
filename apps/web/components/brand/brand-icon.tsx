import {
  siApple,
  siAstro,
  siBun,
  siClaude,
  siCloudflare,
  siDeno,
  siDigitalocean,
  siDiscord,
  siDjango,
  siDotnet,
  siDrizzle,
  siElixir,
  siExpress,
  siGandi,
  siGithub,
  siGmail,
  siGo,
  siGodaddy,
  siGooglecloud,
  siGooglegemini,
  siHetzner,
  siHono,
  siHostinger,
  siIcloud,
  siIonos,
  siJavascript,
  siKotlin,
  siLaravel,
  siNamecheap,
  siNetlify,
  siNextdotjs,
  siNodedotjs,
  siNuxt,
  siOvh,
  siPerplexity,
  siPhp,
  siPorkbun,
  siPrisma,
  siProtonmail,
  siPython,
  siReact,
  siRemix,
  siResend,
  siRuby,
  siRubyonrails,
  siRust,
  siSpaceship,
  siSquarespace,
  siSupabase,
  siSvelte,
  siSwift,
  siThunderbird,
  siTypescript,
  siVercel,
  siWix,
  siX,
  siZoho,
} from "simple-icons"

/*
 * Third-party marks, from Simple Icons (CC0 paths; the marks themselves stay
 * their owners' trademarks and are used only to say "works with"). A few
 * brands Simple Icons no longer carries are drawn here as plain glyphs.
 */
interface IconDef {
  title: string
  path: string
  hex: string
}

const custom = {
  linkedin: {
    title: "LinkedIn",
    hex: "0A66C2",
    path: "M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.34V9h3.41v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28ZM5.34 7.43a2.06 2.06 0 1 1 0-4.13 2.06 2.06 0 0 1 0 4.13ZM7.12 20.45H3.56V9h3.56v11.45ZM22.22 0H1.77C.79 0 0 .77 0 1.73v20.54C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.73V1.73C24 .77 23.2 0 22.22 0Z",
  },
  // The OpenAI blossom, as Simple Icons drew it before the mark was pulled
  // from the set. The hand-drawn stand-in that was here read as a smudge.
  chatgpt: {
    title: "ChatGPT",
    hex: "FFFFFF",
    path: "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z",
  },
  outlook: {
    title: "Outlook",
    hex: "0A64D6",
    path: "M2 5.5 13 3.5v17L2 18.5v-13Zm5.5 3.2c-2 0-3.3 1.6-3.3 3.8s1.3 3.8 3.3 3.8 3.3-1.6 3.3-3.8-1.3-3.8-3.3-3.8Zm0 1.6c1 0 1.6.9 1.6 2.2s-.6 2.2-1.6 2.2-1.6-.9-1.6-2.2.6-2.2 1.6-2.2ZM14.5 7H22v10h-7.5v-1.6h5.9V8.6h-5.9V7Zm0 3.2 3 2 2.9-2v1.7l-2.9 2-3-2v-1.7Z",
  },
  aws: {
    title: "Route 53",
    hex: "FF9900",
    path: "M7 16.5c3 2 7 2.3 10.6.9.5-.2.9.3.4.7-2.2 1.9-6.9 2.5-11 .3-.5-.3-.3-1 0-1.9Zm11.6-.9c-.3-.5-2.3-.3-3.3-.1-.3 0-.3-.2 0-.4 1.6-1.1 4.2-.8 4.5-.4.3.4-.1 3-1.6 4.3-.2.2-.4.1-.3-.2.3-.8 1-2.7.7-3.2ZM12 3l7 4v4.5l-7 4-7-4V7l7-4Zm0 1.8L6.6 7.9 12 11l5.4-3.1L12 4.8Z",
  },
} satisfies Record<string, IconDef>

const registry = {
  apple: siApple,
  astro: siAstro,
  bun: siBun,
  claude: siClaude,
  cloudflare: siCloudflare,
  deno: siDeno,
  digitalocean: siDigitalocean,
  discord: siDiscord,
  django: siDjango,
  dotnet: siDotnet,
  drizzle: siDrizzle,
  elixir: siElixir,
  express: siExpress,
  gandi: siGandi,
  github: siGithub,
  gmail: siGmail,
  go: siGo,
  godaddy: siGodaddy,
  googlecloud: siGooglecloud,
  gemini: siGooglegemini,
  hetzner: siHetzner,
  hono: siHono,
  hostinger: siHostinger,
  icloud: siIcloud,
  ionos: siIonos,
  javascript: siJavascript,
  kotlin: siKotlin,
  laravel: siLaravel,
  namecheap: siNamecheap,
  netlify: siNetlify,
  next: siNextdotjs,
  node: siNodedotjs,
  nuxt: siNuxt,
  ovh: siOvh,
  perplexity: siPerplexity,
  php: siPhp,
  porkbun: siPorkbun,
  prisma: siPrisma,
  proton: siProtonmail,
  python: siPython,
  react: siReact,
  remix: siRemix,
  resend: siResend,
  ruby: siRuby,
  rails: siRubyonrails,
  rust: siRust,
  spaceship: siSpaceship,
  squarespace: siSquarespace,
  supabase: siSupabase,
  svelte: siSvelte,
  swift: siSwift,
  thunderbird: siThunderbird,
  typescript: siTypescript,
  vercel: siVercel,
  wix: siWix,
  x: siX,
  zoho: siZoho,
  ...custom,
} satisfies Record<string, IconDef>

export type BrandName = keyof typeof registry

export const brandTitle = (name: BrandName) => registry[name].title
export const brandHex = (name: BrandName) => `#${registry[name].hex}`

/*
 * A brand's colour, made readable on the dark canvas. Black marks (Next,
 * Bun, Express...) go white; deep navies and greens (OVH, Ionos, Django,
 * Prisma) are lifted toward white just enough to show.
 */
export const brandHexOnDark = (name: BrandName) => {
  const hex = registry[name].hex
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
  if (luminance < 0.02) return "#ffffff"
  if (luminance < 0.12) return `color-mix(in oklch, #${hex} 55%, white)`
  return `#${hex}`
}

export function BrandIcon({
  name,
  size = 20,
  className,
  colored = false,
}: {
  name: BrandName
  size?: number
  className?: string
  colored?: boolean
}) {
  const icon = registry[name]
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      role="img"
      aria-label={icon.title}
      className={className}
      fill={colored ? `#${icon.hex}` : "currentColor"}
    >
      <path d={icon.path} />
    </svg>
  )
}
