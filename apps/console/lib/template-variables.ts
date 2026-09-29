/** `{ "team.name": "Acme" }` as `{ team: { name: "Acme" } }`, as a send passes it. */
export function nest(flat: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [path, value] of Object.entries(flat)) {
    const keys = path.split(".")
    let node = out
    for (const key of keys.slice(0, -1)) {
      const next = node[key]
      node = (
        typeof next === "object" && next !== null ? next : (node[key] = {})
      ) as Record<string, unknown>
    }
    node[keys[keys.length - 1]!] = value
  }
  return out
}
