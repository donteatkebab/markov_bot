const MAX_HINTS = 5

export function getHintsFromTexts(texts = []) {
  if (!texts || texts.length === 0) return []

  const words = texts
    .join(' ')
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^a-zA-Z0-9_\u0600-\u06FF]+/g, ''))
    .filter(
      (w) =>
        w &&
        w.length >= 3 &&
        !w.startsWith('@') &&
        !w.startsWith('http') &&
        !w.startsWith('www')
    )

  const counts = new Map()
  for (const w of words) {
    counts.set(w, (counts.get(w) || 0) + 1)
  }

  const sorted = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([w]) => w)

  return sorted.slice(0, MAX_HINTS)
}
