/*
 * The mark lives in @repo/ui so the landing site, the console and the auth
 * pages draw the same glyph from one set of paths. Re-exported here so the
 * site's imports keep their short path.
 */
export * from "@repo/ui/components/mark"
