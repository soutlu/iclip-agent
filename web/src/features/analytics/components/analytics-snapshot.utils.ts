import type {
  AnalyticsAttentionItem,
  AnalyticsDistributionItem,
  AnalyticsRangeId,
  AnalyticsSourceId,
  AnalyticsSummaryMetric,
  AnalyticsTrendPoint,
  AnalyticsUserStat,
  GenerationAnalyticsSnapshot,
} from '@/features/analytics/api/generation-analytics'
import { z } from 'zod'
import { apiFetch } from '@/shared/api/client'
import { wireRecordSchema } from '@/shared/api/schemas'
import { isRecord } from '@/shared/lib/guards'

/**
 * 解析后端生成统计快照，避免缺失数字字段时页面显示 NaN。
 *
 * @param value - 后端响应中的 analytics 对象。
 * @returns 已校验 summary 数字字段的统计快照。
 * @throws 当 summary 或必要数字字段缺失时抛出错误。
 */
export function parseGenerationAnalyticsSnapshot(
  value: Record<string, unknown>,
): GenerationAnalyticsSnapshot {
  const summary = readRecordField(value, 'summary')

  return {
    attentionItems: readAttentionItems(value),
    durationDistribution: readDistributionItems(value, 'durationDistribution'),
    filters: readAnalyticsFilters(value),
    generatedAt: readFiniteNumber(value, 'generatedAt', 'generatedAt'),
    retryDistribution: readDistributionItems(value, 'retryDistribution'),
    summary: {
      activeUsers: readNumberField(summary, 'activeUsers'),
      avgDurationSeconds: readNumberField(summary, 'avgDurationSeconds'),
      avgRetry: readNumberField(summary, 'avgRetry'),
      completedGenerations: readNumberField(summary, 'completedGenerations'),
      effectiveProjects: readNumberField(summary, 'effectiveProjects'),
      finalVideos: readNumberField(summary, 'finalVideos'),
      medianRetry: readNumberField(summary, 'medianRetry'),
      totalGeneratedDurationSeconds: readNumberField(summary, 'totalGeneratedDurationSeconds'),
    },
    trendPoints: readTrendPoints(value),
    userStats: readUserStats(value),
  }
}

/**
 * 读取并校验后端回传的筛选条件。
 *
 * @param record - 后端响应对象。
 * @returns 已校验的筛选条件。
 * @throws 当筛选条件字段缺失或不合法时抛出错误。
 */
export function readAnalyticsFilters(
  record: Record<string, unknown>,
): GenerationAnalyticsSnapshot['filters'] {
  const filters = readRecordField(record, 'filters')

  return {
    excludeTestData: readBooleanField(filters, 'excludeTestData', 'filters.excludeTestData'),
    range: readRangeId(filters, 'filters.range'),
    source: readSourceId(filters, 'filters.source'),
  }
}

/**
 * 读取并校验需关注项目数据。
 *
 * @param record - 后端响应对象。
 * @returns 已校验的关注项。
 * @throws 当关注项缺少可导航项目字段时抛出错误。
 */
export function readAttentionItems(record: Record<string, unknown>) {
  const items = readArrayField(record, 'attentionItems')

  return items.map((item, index): AnalyticsAttentionItem => {
    if (!isRecord(item)) {
      throw new Error(`统计响应缺少 attentionItems[${index}]`)
    }

    const source = readAttentionSource(item, `attentionItems[${index}].source`)
    const sessionId = readNullableStringField(
      item,
      'sessionId',
      `attentionItems[${index}].sessionId`,
    )

    if (source === 'agent' && sessionId === null) {
      throw new Error(`统计响应缺少 attentionItems[${index}].sessionId`)
    }

    if (source === 'direct' && sessionId !== null) {
      throw new Error(`统计响应字段 attentionItems[${index}].sessionId 与 source 不一致`)
    }

    return {
      avgDurationSeconds: readFiniteNumber(
        item,
        'avgDurationSeconds',
        `attentionItems[${index}].avgDurationSeconds`,
      ),
      avgRetry: readFiniteNumber(item, 'avgRetry', `attentionItems[${index}].avgRetry`),
      id: readStringField(item, 'id', `attentionItems[${index}].id`),
      owner: readStringField(item, 'owner', `attentionItems[${index}].owner`),
      project: readStringField(item, 'project', `attentionItems[${index}].project`),
      projectId: readStringField(item, 'projectId', `attentionItems[${index}].projectId`),
      reason: readStringField(item, 'reason', `attentionItems[${index}].reason`),
      sessionId,
      source,
    }
  })
}

/**
 * 读取并校验分布图数据。
 *
 * @param record - 后端响应对象。
 * @param field - 分布图字段名。
 * @returns 已校验的分布图数据。
 * @throws 当分布图字段缺失或不合法时抛出错误。
 */
export function readDistributionItems(
  record: Record<string, unknown>,
  field: 'durationDistribution' | 'retryDistribution',
) {
  const items = readArrayField(record, field)

  return items.map((item, index): AnalyticsDistributionItem => {
    if (!isRecord(item)) {
      throw new Error(`统计响应缺少 ${field}[${index}]`)
    }

    return {
      count: readFiniteNumber(item, 'count', `${field}[${index}].count`),
      id: readStringField(item, 'id', `${field}[${index}].id`),
      label: readStringField(item, 'label', `${field}[${index}].label`),
      tone: readDistributionTone(item, `${field}[${index}].tone`),
    }
  })
}

/**
 * 读取关注项来源。
 *
 * @param record - 关注项对象。
 * @param path - 错误提示使用的字段路径。
 * @returns 来源类型。
 * @throws 当来源不是 agent/direct 时抛出错误。
 */
export function readAttentionSource(
  record: Record<string, unknown>,
  path: string,
): AnalyticsAttentionItem['source'] {
  const value = record.source

  if (value !== 'agent' && value !== 'direct') {
    throw new Error(`统计响应缺少 ${path}`)
  }

  return value
}

/**
 * 读取并校验趋势图数据点。
 *
 * @param record - 后端响应对象。
 * @returns 已校验的趋势点。
 * @throws 当趋势点字段缺失时抛出错误。
 */
export function readTrendPoints(record: Record<string, unknown>) {
  const points = readArrayField(record, 'trendPoints')

  return points.map((point, index): AnalyticsTrendPoint => {
    if (!isRecord(point)) {
      throw new Error(`统计响应缺少 trendPoints[${index}]`)
    }

    return {
      avgRetry: readFiniteNumber(point, 'avgRetry', `trendPoints[${index}].avgRetry`),
      completedGenerations: readFiniteNumber(
        point,
        'completedGenerations',
        `trendPoints[${index}].completedGenerations`,
      ),
      finalVideos: readFiniteNumber(point, 'finalVideos', `trendPoints[${index}].finalVideos`),
      firstPassVideos: readFiniteNumber(
        point,
        'firstPassVideos',
        `trendPoints[${index}].firstPassVideos`,
      ),
      id: readStringField(point, 'id', `trendPoints[${index}].id`),
      label: readStringField(point, 'label', `trendPoints[${index}].label`),
    }
  })
}

/**
 * 读取并校验用户统计行。
 *
 * @param record - 后端响应对象。
 * @returns 已校验的用户统计行。
 * @throws 当用户统计字段缺失或不合法时抛出错误。
 */
export function readUserStats(record: Record<string, unknown>) {
  const rows = readArrayField(record, 'userStats')

  return rows.map((row, index): AnalyticsUserStat => {
    if (!isRecord(row)) {
      throw new Error(`统计响应缺少 userStats[${index}]`)
    }

    return {
      avgDurationSeconds: readFiniteNumber(
        row,
        'avgDurationSeconds',
        `userStats[${index}].avgDurationSeconds`,
      ),
      avgRetry: readFiniteNumber(row, 'avgRetry', `userStats[${index}].avgRetry`),
      completed: readFiniteNumber(row, 'completed', `userStats[${index}].completed`),
      firstPassRate: readFiniteNumber(row, 'firstPassRate', `userStats[${index}].firstPassRate`),
      id: readStringField(row, 'id', `userStats[${index}].id`),
      projects: readFiniteNumber(row, 'projects', `userStats[${index}].projects`),
      totalGeneratedDurationSeconds: readFiniteNumber(
        row,
        'totalGeneratedDurationSeconds',
        `userStats[${index}].totalGeneratedDurationSeconds`,
      ),
      user: readStringField(row, 'user', `userStats[${index}].user`),
    }
  })
}

/**
 * 从响应对象中读取数组字段。
 *
 * @param record - 响应对象。
 * @param field - 字段名。
 * @returns 数组字段。
 * @throws 当字段不是数组时抛出错误。
 */
export function readArrayField(record: Record<string, unknown>, field: string): unknown[] {
  const value = record[field]

  if (!Array.isArray(value)) {
    throw new Error(`统计响应缺少 ${field}`)
  }

  return value as unknown[]
}

/**
 * 从响应对象中读取嵌套对象字段。
 *
 * @param record - 响应对象。
 * @param field - 字段名。
 * @returns 字段对应的普通对象。
 * @throws 当字段不是普通对象时抛出错误。
 */
export function readRecordField(record: Record<string, unknown>, field: string) {
  const value = record[field]

  if (!isRecord(value)) {
    throw new Error(`统计响应缺少 ${field}`)
  }

  return value
}

/**
 * 从响应对象中读取布尔字段。
 *
 * @param record - 响应对象。
 * @param field - 字段名。
 * @param path - 错误提示使用的字段路径。
 * @returns 布尔字段。
 * @throws 当字段缺失或不是布尔值时抛出错误。
 */
export function readBooleanField(record: Record<string, unknown>, field: string, path: string) {
  const value = record[field]

  if (typeof value !== 'boolean') {
    throw new Error(`统计响应缺少 ${path}`)
  }

  return value
}

/**
 * 从响应对象中读取有限数字字段。
 *
 * @param record - 响应对象。
 * @param field - 字段名。
 * @returns 有限数字。
 * @throws 当字段缺失、不是数字或为 NaN 时抛出错误。
 */
export function readNumberField(record: Record<string, unknown>, field: string) {
  return readFiniteNumber(record, field, `summary.${field}`)
}

/**
 * 从响应对象中读取有限数字字段。
 *
 * @param record - 响应对象。
 * @param field - 字段名。
 * @param path - 错误提示使用的字段路径。
 * @returns 有限数字。
 * @throws 当字段缺失、不是数字或为 NaN 时抛出错误。
 */
export function readFiniteNumber(record: Record<string, unknown>, field: string, path: string) {
  const value = record[field]

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`统计响应缺少 ${path}`)
  }

  return value
}

/**
 * 读取统计时间范围 id。
 *
 * @param record - 响应对象。
 * @param path - 错误提示使用的字段路径。
 * @returns 时间范围 id。
 * @throws 当字段不是合法范围时抛出错误。
 */
export function readRangeId(record: Record<string, unknown>, path: string): AnalyticsRangeId {
  const value = record.range

  if (value !== '1d' && value !== '7d' && value !== '30d' && value !== '90d') {
    throw new Error(`统计响应缺少 ${path}`)
  }

  return value
}

/**
 * 读取统计来源 id。
 *
 * @param record - 响应对象。
 * @param path - 错误提示使用的字段路径。
 * @returns 来源 id。
 * @throws 当字段不是合法来源时抛出错误。
 */
export function readSourceId(record: Record<string, unknown>, path: string): AnalyticsSourceId {
  const value = record.source

  if (value !== 'all' && value !== 'agent' && value !== 'direct') {
    throw new Error(`统计响应缺少 ${path}`)
  }

  return value
}

/**
 * 读取分布图色调。
 *
 * @param record - 响应对象。
 * @param path - 错误提示使用的字段路径。
 * @returns 分布图色调。
 * @throws 当字段不是合法色调时抛出错误。
 */
export function readDistributionTone(
  record: Record<string, unknown>,
  path: string,
): AnalyticsDistributionItem['tone'] {
  const value = record.tone

  if (value !== 'accent' && value !== 'mint' && value !== 'neutral') {
    throw new Error(`统计响应缺少 ${path}`)
  }

  return value
}

/**
 * 从响应对象中读取字符串字段。
 *
 * @param record - 响应对象。
 * @param field - 字段名。
 * @param path - 错误提示使用的字段路径。
 * @returns 字符串字段。
 * @throws 当字段缺失或不是字符串时抛出错误。
 */
export function readStringField(record: Record<string, unknown>, field: string, path: string) {
  const value = record[field]

  if (typeof value !== 'string') {
    throw new Error(`统计响应缺少 ${path}`)
  }

  return value
}

/**
 * 从响应对象中读取可空字符串字段。
 *
 * @param record - 响应对象。
 * @param field - 字段名。
 * @param path - 错误提示使用的字段路径。
 * @returns 字符串或 null。
 * @throws 当字段既不是字符串也不是 null 时抛出错误。
 */
export function readNullableStringField(
  record: Record<string, unknown>,
  field: string,
  path: string,
) {
  const value = record[field]

  if (value === null) {
    return null
  }

  if (typeof value !== 'string') {
    throw new Error(`统计响应缺少 ${path}`)
  }

  return value
}

/**
 * 把后端 summary 转换成指标展示数据。
 *
 * @param snapshot - 后端统计快照。
 * @returns 指标数组。
 */
export function createSummaryMetrics(
  snapshot: GenerationAnalyticsSnapshot,
): AnalyticsSummaryMetric[] {
  return [
    {
      id: 'effective-projects',
      label: '总项目',
      value: formatNumber(snapshot.summary.effectiveProjects),
    },
    {
      id: 'completed-generations',
      label: '生成视频条数',
      value: formatNumber(snapshot.summary.completedGenerations),
    },
    {
      id: 'active-users',
      label: '用户数',
      value: formatNumber(snapshot.summary.activeUsers),
    },
    {
      id: 'final-videos',
      label: '最终成片',
      value: formatNumber(snapshot.summary.finalVideos),
    },
    {
      id: 'avg-retry',
      label: '平均重试',
      value: formatDecimal(snapshot.summary.avgRetry),
    },
    {
      id: 'median-retry',
      label: '中位重试',
      value: formatDecimal(snapshot.summary.medianRetry),
    },
    {
      id: 'avg-duration',
      label: '平均生成耗时',
      value: formatDuration(snapshot.summary.avgDurationSeconds),
    },
    {
      id: 'total-generated-duration',
      label: '生成总时长',
      value: formatDuration(snapshot.summary.totalGeneratedDurationSeconds),
    },
  ]
}

/**
 * 格式化整数。
 *
 * @param value - 数值。
 * @returns 中文数字格式。
 */
export function formatNumber(value: number) {
  return new Intl.NumberFormat('zh-CN').format(value)
}

/**
 * 格式化小数。
 *
 * @param value - 数值。
 * @returns 最多两位小数。
 */
export function formatDecimal(value: number) {
  return new Intl.NumberFormat('zh-CN', {
    maximumFractionDigits: 2,
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
  }).format(value)
}

/**
 * 格式化百分比。
 *
 * @param value - 0 到 1 的比例。
 * @returns 百分比文案。
 */
export function formatRate(value: number) {
  return `${Math.round(value * 100)}%`
}

/**
 * 格式化秒级耗时。
 *
 * @param seconds - 秒数。
 * @returns 可读耗时。
 */
export function formatDuration(seconds: number) {
  const normalizedSeconds = Math.max(0, Math.round(seconds))
  const hours = Math.floor(normalizedSeconds / 3600)
  const minutes = Math.floor((normalizedSeconds % 3600) / 60)
  const remainingSeconds = normalizedSeconds % 60

  if (hours > 0) {
    return `${hours}小时${minutes}分`
  }

  if (minutes > 0) {
    return remainingSeconds > 0 ? `${minutes}分${remainingSeconds}秒` : `${minutes}分`
  }

  return `${remainingSeconds}秒`
}

/** 后端 `/analytics/generation-stats` 响应；analytics 内部结构由 parseGenerationAnalyticsSnapshot 收口。 */
const generationAnalyticsEnvelopeSchema = z.object(
  { analytics: wireRecordSchema('统计响应格式无效') },
  { error: '统计响应格式无效' },
)

/**
 * 拉取后端生成统计快照。
 *
 * @param filters - 统计筛选条件。
 * @param signal - 请求取消信号。
 * @returns 后端统计快照。
 */
export async function fetchGenerationAnalytics(
  filters: Pick<GenerationAnalyticsSnapshot['filters'], 'range' | 'source'>,
  signal: AbortSignal,
): Promise<GenerationAnalyticsSnapshot> {
  const searchParams = new URLSearchParams({
    range: filters.range,
    source: filters.source,
  })
  const payload = await apiFetch(
    `/analytics/generation-stats?${searchParams.toString()}`,
    generationAnalyticsEnvelopeSchema,
    {
      cache: 'no-store',
      fallbackErrorMessage: '加载统计数据失败',
      signal,
    },
  )

  return parseGenerationAnalyticsSnapshot(payload.analytics)
}
