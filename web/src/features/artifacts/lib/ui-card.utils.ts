import type {
  UiCardArtifactOutput,
  UiCardKeyValueRow,
  UiCardMetricItem,
  UiCardSection,
} from '@/features/artifacts/types/ui-card.types'
import { isRecord } from '@/shared/lib/guards'

const getNonEmptyString = (value: unknown) =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined

const getFiniteNumber = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value
  }

  if (typeof value === 'string') {
    const normalized = value.trim()

    if (normalized.length === 0) {
      return undefined
    }

    const parsedValue = Number(normalized)

    if (Number.isFinite(parsedValue) && parsedValue > 0) {
      return parsedValue
    }
  }

  return undefined
}

const getStringArray = (value: unknown) => {
  if (!Array.isArray(value)) {
    return []
  }

  return value.flatMap((item) => {
    const normalized = getNonEmptyString(item)

    return normalized ? [normalized] : []
  })
}

const normalizeKeyValueRows = (value: unknown): UiCardKeyValueRow[] => {
  if (!Array.isArray(value)) {
    return []
  }

  return value.flatMap((item) => {
    if (!isRecord(item)) {
      return []
    }

    const label = getNonEmptyString(item.label)
    const rowValue = getNonEmptyString(item.value)

    return label && rowValue
      ? [
          {
            label,
            value: rowValue,
          },
        ]
      : []
  })
}

const normalizeMetricItems = (value: unknown): UiCardMetricItem[] => {
  if (!Array.isArray(value)) {
    return []
  }

  return value.flatMap((item) => {
    if (!isRecord(item)) {
      return []
    }

    const label = getNonEmptyString(item.label)
    const metricValue = getNonEmptyString(item.value)

    return label && metricValue
      ? [
          {
            label,
            value: metricValue,
          },
        ]
      : []
  })
}

const normalizeSection = (value: unknown): UiCardSection | null => {
  if (!isRecord(value)) {
    return null
  }

  switch (value.type) {
    case 'paragraph': {
      const text = getNonEmptyString(value.text)

      return text
        ? {
            text,
            type: 'paragraph',
          }
        : null
    }
    case 'keyValue':
    case 'key_value': {
      const rows = normalizeKeyValueRows(value.rows ?? value.items)

      return rows.length > 0
        ? {
            rows,
            type: 'keyValue',
          }
        : null
    }
    case 'list': {
      const items = getStringArray(value.items)

      return items.length > 0
        ? {
            items,
            type: 'list',
          }
        : null
    }
    case 'metricGrid':
    case 'metric_grid': {
      const items = normalizeMetricItems(value.items)

      return items.length > 0
        ? {
            items,
            type: 'metricGrid',
          }
        : null
    }
    case 'media': {
      const alt = getNonEmptyString(value.alt)
      const src = getNonEmptyString(value.src)

      return alt && src
        ? {
            alt,
            aspectRatio: getFiniteNumber(value.aspectRatio ?? value.aspect_ratio),
            src,
            type: 'media',
          }
        : null
    }
    case 'tagRow':
    case 'tag_row': {
      const items = getStringArray(value.items)

      return items.length > 0
        ? {
            items,
            type: 'tagRow',
          }
        : null
    }
    default:
      return null
  }
}

export const normalizeUiCardArtifactOutput = (value: unknown): UiCardArtifactOutput | null => {
  if (!isRecord(value)) {
    return null
  }

  const title = getNonEmptyString(value.title)

  if (!title) {
    return null
  }

  const badges = getStringArray(value.badges)
  const sections = Array.isArray(value.sections)
    ? value.sections.flatMap((item) => {
        const normalized = normalizeSection(item)

        return normalized ? [normalized] : []
      })
    : []

  return {
    badges: badges.length > 0 ? badges : undefined,
    sections,
    subtitle: getNonEmptyString(value.subtitle),
    title,
  }
}
