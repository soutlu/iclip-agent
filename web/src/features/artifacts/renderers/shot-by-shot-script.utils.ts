export interface ShotByShotScriptSegment {
  endTime: string
  rangeLabel: string
  startTime: string
  text: string
  title: string
}

export interface ShotByShotScriptGroup {
  segments: ShotByShotScriptSegment[]
  title: string
}

export interface ShotByShotScriptModel {
  durationLabel: string
  groups: ShotByShotScriptGroup[]
  segmentCount: number
  title: string
}

const MARKDOWN_TABLE_SEPARATOR_PATTERN = /^:?-{3,}:?$/
const MARKDOWN_DECORATION_PATTERN = /[*_`]/g
const MARKDOWN_HEADING_MARKER_PATTERN = /^#{1,6}\s+/
const MARKDOWN_LINK_PATTERN = /\[([^\]]+)\]\([^)]+\)/g
const HTML_TAG_PATTERN = /<[^>]+>/g
const SHOT_BY_SHOT_TITLE_PATTERN = /逐镜拉片表|shot-by-shot script/i
const STORYLINE_HEADER_PATTERN = /^storyline$/i
const TIME_RANGE_PATTERN = /\[(\d{2}:\d{2}(?:\.\d{1,3})?)-(\d{2}:\d{2}(?:\.\d{1,3})?)\]\s*([^[]+)/g
const SENTENCE_SPLIT_PATTERN = /[，,。；;.!！?？]/

interface MarkdownTable {
  headers: string[]
  rows: string[][]
}

const normalizeMarkdownCell = (value: string): string =>
  value
    .replaceAll('<br>', ' ')
    .replaceAll('<br/>', ' ')
    .replaceAll('<br />', ' ')
    .replace(MARKDOWN_LINK_PATTERN, '$1')
    .replace(HTML_TAG_PATTERN, '')
    .replace(MARKDOWN_DECORATION_PATTERN, '')
    .replace(/\s+/g, ' ')
    .trim()

const splitMarkdownTableRow = (line: string): string[] | null => {
  const trimmedLine = line.trim()

  if (!trimmedLine.startsWith('|') || !trimmedLine.endsWith('|')) {
    return null
  }

  return trimmedLine.slice(1, -1).split('|').map(normalizeMarkdownCell)
}

const isMarkdownTableSeparatorRow = (cells: string[]): boolean =>
  cells.length > 0 && cells.every((cell) => MARKDOWN_TABLE_SEPARATOR_PATTERN.test(cell.trim()))

const parseMarkdownTables = (markdown: string): MarkdownTable[] => {
  const lines = markdown.split('\n')
  const tables: MarkdownTable[] = []

  for (let index = 0; index < lines.length - 1; index += 1) {
    const headers = splitMarkdownTableRow(lines[index] ?? '')
    const separator = splitMarkdownTableRow(lines[index + 1] ?? '')

    if (!headers || !separator || !isMarkdownTableSeparatorRow(separator)) {
      continue
    }

    const rows: string[][] = []
    let rowIndex = index + 2

    while (rowIndex < lines.length) {
      const row = splitMarkdownTableRow(lines[rowIndex] ?? '')

      if (!row) {
        break
      }

      rows.push(row)
      rowIndex += 1
    }

    tables.push({ headers, rows })
    index = rowIndex
  }

  return tables
}

const findShotByShotTable = (markdown: string): MarkdownTable | null =>
  parseMarkdownTables(markdown).find((table) => {
    const hasStructureHeader = table.headers.some((header) => header.includes('结构层级'))
    const hasStorylineHeader = table.headers.some((header) => STORYLINE_HEADER_PATTERN.test(header))

    return hasStructureHeader && hasStorylineHeader
  }) ?? null

const secondsFromTimecode = (timecode: string): number => {
  const [minuteSecondPart = '', millisecondPart = '0'] = timecode.split('.')
  const [minutes = '0', seconds = '0'] = minuteSecondPart.split(':')

  return Number(minutes) * 60 + Number(seconds) + Number(`0.${millisecondPart}`)
}

const formatSecondValue = (seconds: number): string => {
  if (Number.isInteger(seconds)) {
    return seconds.toString()
  }

  return seconds.toFixed(1).replace(/\.0$/, '')
}

const formatTimeRangeLabel = (startTime: string, endTime: string): string =>
  `${formatSecondValue(secondsFromTimecode(startTime))}-${formatSecondValue(secondsFromTimecode(endTime))}s`

const createSegmentTitle = (text: string): string => {
  const fragments = text
    .split(SENTENCE_SPLIT_PATTERN)
    .map((fragment) => fragment.trim())
    .filter(Boolean)
    .slice(0, 2)

  return fragments.length > 0 ? fragments.join(' · ') : '镜头脚本'
}

const parseStorylineSegments = (storyline: string): ShotByShotScriptSegment[] =>
  Array.from(storyline.matchAll(TIME_RANGE_PATTERN))
    .map((match) => {
      const [, startTime, endTime, rawText] = match
      const text = normalizeMarkdownCell(rawText ?? '')

      if (!startTime || !endTime || text.length === 0) {
        return null
      }

      return {
        endTime,
        rangeLabel: formatTimeRangeLabel(startTime, endTime),
        startTime,
        text,
        title: createSegmentTitle(text),
      }
    })
    .filter((segment): segment is ShotByShotScriptSegment => segment !== null)

const extractShotByShotTitle = (markdown: string): string => {
  const heading = markdown
    .split('\n')
    .map((line) => line.trim())
    .find(
      (line) => MARKDOWN_HEADING_MARKER_PATTERN.test(line) && SHOT_BY_SHOT_TITLE_PATTERN.test(line),
    )

  if (!heading) {
    return '逐镜拉片表'
  }

  return normalizeMarkdownCell(heading.replace(MARKDOWN_HEADING_MARKER_PATTERN, '')).replace(
    /\s*\(Shot-by-Shot Script\)\s*/i,
    '',
  )
}

export const parseShotByShotScriptMarkdown = (markdown: string): ShotByShotScriptModel | null => {
  if (!SHOT_BY_SHOT_TITLE_PATTERN.test(markdown)) {
    return null
  }

  const table = findShotByShotTable(markdown)

  if (!table) {
    return null
  }

  const structureIndex = table.headers.findIndex((header) => header.includes('结构层级'))
  const storylineIndex = table.headers.findIndex((header) => STORYLINE_HEADER_PATTERN.test(header))

  if (structureIndex < 0 || storylineIndex < 0) {
    return null
  }

  const groups: ShotByShotScriptGroup[] = []
  let currentGroupTitle = ''

  for (const row of table.rows) {
    const explicitGroupTitle = normalizeMarkdownCell(row[structureIndex] ?? '')
    const storyline = normalizeMarkdownCell(row[storylineIndex] ?? '')
    const segments = parseStorylineSegments(storyline)

    if (explicitGroupTitle.length > 0) {
      currentGroupTitle = explicitGroupTitle
    }

    if (currentGroupTitle.length === 0 || segments.length === 0) {
      continue
    }

    const existingGroup = groups.find((group) => group.title === currentGroupTitle)

    if (existingGroup) {
      existingGroup.segments.push(...segments)
      continue
    }

    groups.push({
      segments,
      title: currentGroupTitle,
    })
  }

  const segmentCount = groups.reduce((count, group) => count + group.segments.length, 0)
  const lastSegment = groups.flatMap((group) => group.segments).at(-1)

  if (segmentCount === 0 || !lastSegment) {
    return null
  }

  const durationLabel = `${formatSecondValue(secondsFromTimecode(lastSegment.endTime))}s`

  return {
    durationLabel,
    groups,
    segmentCount,
    title: extractShotByShotTitle(markdown),
  }
}
