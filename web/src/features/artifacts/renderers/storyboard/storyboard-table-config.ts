import type { StoryboardOutput, StoryboardShot } from '@/features/artifacts/types/storyboard.types'

export interface StoryboardPalette {
  accent: string
  accentSoft: string
  background: string
  badgeBorder: string
  danger: string
  dangerSoft: string
  line: string
  promptSurface: string
  stageClosureBackground: string
  stageClosureText: string
  stageDemoBackground: string
  stageDemoText: string
  stageHookBackground: string
  stageHookText: string
  stageNeutralBackground: string
  stageNeutralText: string
  stageProofBackground: string
  stageProofText: string
  surface: string
  textPrimary: string
  textSecondary: string
  tertiary: string
  tertiarySoft: string
}

export interface StoryboardSummaryItem {
  key: string
  label: string
  tone: 'danger' | 'neutral' | 'tertiary'
  value: string
}

export interface StoryboardTableColumn {
  key: 'finalVideo' | 'frames' | 'id' | 'storyline' | 'structureLevel' | 'videoPrompt'
  label: string
  width: number
}

const BOARD_MIN_WIDTH = 1600
const BOARD_MIN_WIDTH_WITH_VIDEO = 1860
const EMPTY_VALUE = '待补充'

export const TABLE_HEAD_CELL_CLASS =
  'px-4 py-4 text-left text-body font-semibold uppercase tracking-[0]'
export const TABLE_BODY_CELL_CLASS = 'border-b px-4 py-6 align-top'

export const STORYBOARD_PALETTE: StoryboardPalette = {
  accent: 'var(--color-sb-table-accent)',
  accentSoft: 'var(--color-sb-table-accent-soft)',
  background: 'var(--color-sb-table-background)',
  badgeBorder: 'var(--color-sb-table-badge-border)',
  danger: 'var(--color-sb-table-danger)',
  dangerSoft: 'var(--color-sb-table-danger-soft)',
  line: 'var(--color-sb-table-line)',
  promptSurface: 'var(--color-sb-table-prompt-surface)',
  stageClosureBackground: 'var(--color-sb-table-stage-closure-bg)',
  stageClosureText: 'var(--color-sb-table-stage-closure-text)',
  stageDemoBackground: 'var(--color-sb-table-stage-demo-bg)',
  stageDemoText: 'var(--color-sb-table-stage-demo-text)',
  stageHookBackground: 'var(--color-sb-table-stage-hook-bg)',
  stageHookText: 'var(--color-sb-table-stage-hook-text)',
  stageNeutralBackground: 'var(--color-sb-table-stage-neutral-bg)',
  stageNeutralText: 'var(--color-sb-table-stage-neutral-text)',
  stageProofBackground: 'var(--color-sb-table-stage-proof-bg)',
  stageProofText: 'var(--color-sb-table-stage-proof-text)',
  surface: 'var(--color-sb-table-surface)',
  textPrimary: 'var(--color-sb-table-text)',
  textSecondary: 'var(--color-sb-table-text-secondary)',
  tertiary: 'var(--color-sb-table-tertiary)',
  tertiarySoft: 'var(--color-sb-table-tertiary-soft)',
}

const STORYBOARD_COLUMNS: StoryboardTableColumn[] = [
  { key: 'id', label: 'ID', width: 84 },
  { key: 'structureLevel', label: '结构节点', width: 240 },
  { key: 'storyline', label: '时间线叙事', width: 520 },
  { key: 'frames', label: '分镜帧', width: 248 },
  { key: 'videoPrompt', label: 'Video Prompt', width: 380 },
  { key: 'finalVideo', label: '最终视频', width: 252 },
]

export const hasText = (value: string | undefined): value is string =>
  typeof value === 'string' && value.trim().length > 0

export const getDisplayValue = (value: string | undefined, fallback = EMPTY_VALUE) => {
  if (!hasText(value)) {
    return fallback
  }

  return value.trim()
}

export const getStoryboardRowLabel = (shot: StoryboardShot) =>
  hasText(shot.id) ? `分镜 ${shot.id}` : '分镜'

const hasStoryboardVideoColumnData = (shot: StoryboardShot) =>
  shot.videoStatus !== undefined ||
  hasText(shot.videoUrl) ||
  hasText(shot.videoError) ||
  hasText(shot.videoTaskId)

const hasStoryboardFrameColumnData = (shot: StoryboardShot) =>
  shot.imageUrls?.some((url) => hasText(url)) ?? false

const hasStoryboardVideoPromptColumnData = (shot: StoryboardShot) =>
  shot.videoPromptStatus !== undefined ||
  hasText(shot.videoPrompt) ||
  hasText(shot.videoPromptError)

export const getStoryboardVideoLabel = (shot: StoryboardShot) =>
  `${getStoryboardRowLabel(shot)} · 最终视频`

export const getStoryboardTableConfig = (shots: StoryboardShot[]) => {
  const hasVideoColumn = shots.some(hasStoryboardVideoColumnData)
  const hasFrameColumn = shots.some(hasStoryboardFrameColumnData)
  const hasVideoPromptColumn = shots.some(hasStoryboardVideoPromptColumnData)
  const columns = STORYBOARD_COLUMNS.filter((column) => {
    switch (column.key) {
      case 'frames':
        return hasFrameColumn
      case 'videoPrompt':
        return hasVideoPromptColumn
      case 'finalVideo':
        return hasVideoColumn
      default:
        return true
    }
  })
  const columnWidthSum = columns.reduce((width, column) => width + column.width, 0)

  return {
    boardMinWidth: Math.max(
      columnWidthSum,
      hasVideoColumn ? BOARD_MIN_WIDTH_WITH_VIDEO : BOARD_MIN_WIDTH,
    ),
    columns,
  }
}

export const getStructureLevelStyle = (
  palette: StoryboardPalette,
  structureLevel: string | undefined,
) => {
  const normalizedLevel = structureLevel?.trim().toLowerCase() ?? ''

  if (
    normalizedLevel.includes('hook') ||
    normalizedLevel.includes('opening') ||
    normalizedLevel.includes('开箱')
  ) {
    return {
      backgroundColor: palette.stageHookBackground,
      color: palette.stageHookText,
    }
  }

  if (
    normalizedLevel.includes('proof') ||
    normalizedLevel.includes('detail') ||
    normalizedLevel.includes('demo') ||
    normalizedLevel.includes('showcase')
  ) {
    return {
      backgroundColor: palette.stageProofBackground,
      color: palette.stageProofText,
    }
  }

  if (
    normalizedLevel.includes('reveal') ||
    normalizedLevel.includes('aesthetic') ||
    normalizedLevel.includes('visual')
  ) {
    return {
      backgroundColor: palette.stageDemoBackground,
      color: palette.stageDemoText,
    }
  }

  if (
    normalizedLevel.includes('closing') ||
    normalizedLevel.includes('ending') ||
    normalizedLevel.includes('cta')
  ) {
    return {
      backgroundColor: palette.stageClosureBackground,
      color: palette.stageClosureText,
    }
  }

  return {
    backgroundColor: palette.stageNeutralBackground,
    color: palette.stageNeutralText,
  }
}

export const getStoryboardSummaryItems = (
  storyboard: StoryboardOutput,
): StoryboardSummaryItem[] => {
  const shots = storyboard.shotTable ?? []

  if (shots.length === 0) {
    return []
  }

  const frameCount = shots.filter((shot) => hasStoryboardFrameColumnData(shot)).length
  const videoCount = shots.filter(
    (shot) => shot.videoStatus === 'succeeded' && hasText(shot.videoUrl),
  ).length
  const failedCount = shots.filter(
    (shot) =>
      shot.shotStatus === 'failed' ||
      shot.videoPromptStatus === 'failed' ||
      shot.videoStatus === 'failed',
  ).length

  const items: StoryboardSummaryItem[] = []

  if (frameCount > 0) {
    items.push({
      key: 'frames',
      label: '已生成分镜帧',
      tone: 'tertiary',
      value: `${frameCount} / ${shots.length}`,
    })
  }

  if (videoCount > 0) {
    items.push({
      key: 'videos',
      label: '已生成视频',
      tone: 'neutral',
      value: `${videoCount} / ${shots.length}`,
    })
  }

  if (failedCount > 0) {
    items.push({
      key: 'failed',
      label: '异常段落',
      tone: 'danger',
      value: `${failedCount} 段`,
    })
  }

  return items
}

export const getSummaryItemStyle = (item: StoryboardSummaryItem, palette: StoryboardPalette) => {
  switch (item.tone) {
    case 'danger':
      return {
        backgroundColor: palette.dangerSoft,
        borderColor: 'color-mix(in srgb, var(--color-sb-table-danger) 18%, transparent)',
        color: palette.danger,
      }
    case 'tertiary':
      return {
        backgroundColor: palette.tertiarySoft,
        borderColor: palette.badgeBorder,
        color: palette.tertiary,
      }
    default:
      return {
        backgroundColor: palette.background,
        borderColor: palette.badgeBorder,
        color: palette.textPrimary,
      }
  }
}
