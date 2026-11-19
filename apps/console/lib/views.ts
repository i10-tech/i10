/**
 * The cookie side of the remembered list views - plain, so a server page can
 * read it as well as the client. See components/list/remembered-views.
 */

export type View = "grid" | "table"

/** The cookie a list page's chosen view is kept in, so the server knows it. */
export const viewCookie = (key: string) => `i10-view-${key}`
