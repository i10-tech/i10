"use client"

import { ButtonLink } from "@repo/ui/components/i10/button-link"
import { EmptyState as ArcEmptyState } from "@repo/ui/components/empty-state/empty-state"

/**
 * An empty list or first-run view: Arc's EmptyState, with the console's
 * action shape (a link) and an optional second control beside it.
 */
export function EmptyState({
  title,
  description = "",
  action,
  secondary,
  icon,
  className,
}: {
  title: string
  description?: string
  action?: { label: string; href: string }
  secondary?: React.ReactNode
  icon?: React.ReactNode
  className?: string
}) {
  const actions =
    action || secondary ? (
      <div className="flex flex-wrap items-center justify-center gap-2">
        {action && (
          <ButtonLink href={action.href} size="sm">
            {action.label}
          </ButtonLink>
        )}
        {secondary}
      </div>
    ) : undefined
  return (
    <ArcEmptyState
      title={title}
      description={description}
      action={actions}
      icon={icon}
      className={className}
    />
  )
}
