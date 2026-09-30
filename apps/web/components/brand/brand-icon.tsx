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
  chatgpt: {
    title: "ChatGPT",
    hex: "FFFFFF",
    path: "M12 2.2a4.6 4.6 0 0 1 4.1 2.5 4.6 4.6 0 0 1 4.7 1.9 4.6 4.6 0 0 1 .5 4.5 4.6 4.6 0 0 1-.4 5.1 4.6 4.6 0 0 1-4.5 2.5A4.6 4.6 0 0 1 12 21.8a4.6 4.6 0 0 1-4.1-2.5 4.6 4.6 0 0 1-4.7-1.9 4.6 4.6 0 0 1-.5-4.5 4.6 4.6 0 0 1 .4-5.1 4.6 4.6 0 0 1 4.5-2.5A4.6 4.6 0 0 1 12 2.2Zm0 1.6a3 3 0 0 0-2.9 2.2L12 7.7l2.9-1.7A3 3 0 0 0 12 3.8Zm-4.6 3.9a3 3 0 0 0-2.4 4.2l2.9 1.7V9.2l-.5-1.5Zm9.2 0-.5 1.5v4.4l2.9-1.7a3 3 0 0 0-2.4-4.2ZM12 9.4l-2.2 1.3v2.6l2.2 1.3 2.2-1.3v-2.6L12 9.4Zm-4.1 6.4-2.9 1.7a3 3 0 0 0 4.1 1.9L12 17.7l-4.1-1.9Zm8.2 0L12 17.7l2.9 1.7a3 3 0 0 0 4.1-1.9l-2.9-1.7Z",
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
