import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { Slot } from "radix-ui"

/**
 * A short label on a row: a status, a mode, a kind.
 *
 * ⚠ RESTRAINED ON PURPOSE (#145). shadcn's default is a solid primary pill -
 * black on white, white on black - and a column of those reads as a row of
 * buttons, or as the promo chips generated interfaces scatter everywhere. A
 * badge here is a quiet word in a box: small radius, one weight, no fill
 * stronger than a wash, no glow, no gradient, no icon unless it carries
 * meaning the word does not.
 *
 * ⚠ COLOUR IS STATE, AS EVERYWHERE ELSE IN THE CONSOLE (docs/decisions/
 * console.md section 3). `destructive` is the only coloured variant, and it is
 * a red word on a red hairline, not a red slab.
 *
 * ⚠ `rounded-[5px]`, NOT A RADIUS TOKEN. The scale starts at `--radius-sm` =
 * 10px, half this badge's 20px height, which is a pill again by another name.
 *
 * `default` and `secondary` are the same quiet wash, kept as two names so the
 * call sites that map statuses to variants keep compiling; `outline` is the
 * hairline-only form for the less important of two labels.
 */
const badgeVariants = cva(
  "inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-[5px] border px-1.5 text-xs leading-none font-medium whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background aria-invalid:border-danger [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-track text-foreground/80 [a&]:hover:text-foreground",
        secondary:
          "border-transparent bg-track text-foreground/80 [a&]:hover:text-foreground",
        destructive: "border-danger/30 text-danger",
        outline:
          "border-border text-muted-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
        ghost:
          "border-transparent text-muted-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
        link: "border-transparent text-foreground underline-offset-4 [a&]:hover:underline",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
)

function Badge({
  className,
  variant = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span"

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
