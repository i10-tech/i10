import { defineShape } from "@/lib/shapes"

export type UnsubscribePageData = Record<string, never>
export type UnsubscribePageShape = Record<string, never>

export const unsubscribePageShape = defineShape<
  UnsubscribePageShape,
  UnsubscribePageData
>({
  page: "unsubscribe-page",
  fallback: {},
  of: () => ({}),
  parse: (raw) => (typeof raw === "object" && raw !== null ? {} : null),
})
