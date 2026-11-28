// Lua scripts imported as text (`import x from "./x.lua" with { type: "text" }`).
// bun inlines them into the bundle at build time.
declare module "*.lua" {
  const source: string
  export default source
}
