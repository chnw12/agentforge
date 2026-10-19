/**
 * Palette search: every whitespace-separated token must appear (case-insensitive) in the item's text.
 * Items whose title starts with the first token rank first, then earlier matches; ties keep their input order.
 */
export function rankItems<T extends { title: string; text: string }>(query: string, items: T[]): T[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return items
  const scored: { item: T; score: number; order: number }[] = []
  items.forEach((item, order) => {
    const text = item.text.toLowerCase()
    if (!tokens.every((t) => text.includes(t))) return
    const title = item.title.toLowerCase()
    const score = (title.startsWith(tokens[0]!) ? 0 : title.includes(tokens[0]!) ? 1 : 2) * 10_000 + Math.min(text.indexOf(tokens[0]!), 9_999)
    scored.push({ item, score, order })
  })
  return scored.sort((a, b) => a.score - b.score || a.order - b.order).map((s) => s.item)
}
