const COLOR_BOARD_FALLBACKS = [
  'var(--color-brief-board-1)',
  'var(--color-brief-board-2)',
  'var(--color-brief-board-3)',
  'var(--color-brief-board-4)',
  'var(--color-brief-board-5)',
] as const

const hasText = (value: string | undefined | null): value is string =>
  typeof value === 'string' && value.trim().length > 0

const isHexColor = (value: string) => /^#(?:[\dA-F]{3}|[\dA-F]{6})$/iu.test(value.trim())

export const getPaletteSwatchColor = (entry: string, index: number) => {
  if (hasText(entry) && isHexColor(entry)) {
    return entry.trim()
  }

  return COLOR_BOARD_FALLBACKS[index % COLOR_BOARD_FALLBACKS.length]
}

export const buildPaletteBoardBackground = (entries: string[]) => {
  const resolvedEntries = entries.length > 0 ? entries : [...COLOR_BOARD_FALLBACKS]
  const lastIndex = Math.max(resolvedEntries.length - 1, 1)
  let cursor = 0

  const stops = resolvedEntries.flatMap((entry, index) => {
    const color = getPaletteSwatchColor(entry, index)
    const end = index === resolvedEntries.length - 1 ? 100 : ((index + 1) / (lastIndex + 1)) * 100
    const range = [`${color} ${cursor.toFixed(2)}%`, `${color} ${end.toFixed(2)}%`]

    cursor = end

    return range
  })

  return `linear-gradient(90deg, ${stops.join(', ')})`
}
