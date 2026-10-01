/**
 * The cookie the desktop rail's width lives in (#153).
 *
 * ⚠ IN ITS OWN PLAIN MODULE, NOT EXPORTED FROM components/rail.tsx. That file
 * is `"use client"`, and a server component importing a constant from a client
 * module gets a client-reference proxy instead of the string - so the layout's
 * `cookies().get(...)` looked up nothing and every load rendered the rail
 * expanded, then snapped it shut on hydration.
 */
export const RAIL_COOKIE = "i10_rail"
