/** 审计报表的 mock：从内存对话推出一套自洽的明细，再按合同 §12 的口径汇总成 summary 与异常。

单测与 dev:mock 共用；数字按对话下标确定地生成，同一组对话每次都算出同样的结果。

这里的聚合只是让演示数据自洽，不是后端口径的参考实现：测试要断言数字就用 `server.use` 喂自己的 fixture，不拿它算出来的值当预期值。 */

import { http, HttpResponse } from 'msw'
import type { z } from 'zod'
import type {
  zAnomalyOut,
  zConversationAuditOut,
  zMetricsOut,
  zSpreadOut,
} from '@/shared/api/generated/zod.gen'
import { mockAuthUser, mockGovernor } from './auth-user'
import { mockConversations, type MockConversation } from './conversations'

type Metrics = z.output<typeof zMetricsOut>
type Spread = z.output<typeof zSpreadOut>
type Report = z.output<typeof zConversationAuditOut>
type Anomaly = z.output<typeof zAnomalyOut>

const HOUR_MS = 60 * 60_000

/** 与 handlers.addMockUser 同一条规则：其他人的用户名是 id 的前八位。 */
const usernameOf = (ownerUserId: string): string =>
  ownerUserId === mockAuthUser.id
    ? mockAuthUser.username
    : ownerUserId === mockGovernor.id
      ? mockGovernor.username
      : ownerUserId.slice(0, 8)

const spread = (values: number[]): Spread | null => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const at = (q: number) => {
    const position = (sorted.length - 1) * q
    const low = Math.floor(position)
    const high = Math.ceil(position)
    const lower = sorted[low] ?? 0
    return lower + ((sorted[high] ?? lower) - lower) * (position - low)
  }
  return {
    avg: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    median: at(0.5),
    p90: at(0.9),
  }
}

const usageOf = (
  input: number,
  cacheRead: number,
  cacheWrite: number,
  output: number,
  requests: number,
) => {
  const readIn = input + cacheRead + cacheWrite
  return {
    cacheHitRate: readIn === 0 ? null : cacheRead / readIn,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    inputTokens: input,
    outputTokens: output,
    requests,
    totalTokens: readIn + output,
  }
}

/** 一段对话的明细：镜数、每镜次数、周期都由下标定，第三段起每三段有一镜反复重试。 */
const reportOf = (conversation: MockConversation, index: number): Report => {
  const shotCount = 2 + (index % 3)
  const deliveredAt = new Date(conversation.updatedAt)
  const cycleSeconds = (1.5 + (index % 5) * 0.8) * 3600
  const shots = Array.from({ length: shotCount }, (_, shotIndex) => {
    const attempts = shotIndex === 1 && index % 3 === 2 ? 3 : 1 + ((index + shotIndex) % 2)
    const firstAt = new Date(deliveredAt.getTime() - cycleSeconds * 1000 + shotIndex * 15 * 60_000)
    return {
      attempts,
      firstAt: firstAt.toISOString(),
      oneTake: attempts === 1,
      lastAt: new Date(firstAt.getTime() + (attempts - 1) * 12 * 60_000).toISOString(),
      shot: shotIndex + 1,
    }
  })
  const attempts = shots.reduce((sum, shot) => sum + shot.attempts, 0)
  const completed = shotCount + Math.max(0, attempts - shotCount - 1)
  const usage = usageOf(9000 + index * 1200, 6000 + index * 800, 900, 2200 + index * 150, 6 + index)
  const metrics: Metrics = {
    attempts,
    attemptsPerShot: attempts / shotCount,
    completedVideos: completed,
    cycleSeconds: { avg: cycleSeconds, median: cycleSeconds, p90: cycleSeconds },
    deliveredConversations: 1,
    deliveredOrphanConversations: conversation.taskId === null ? 1 : 0,
    deliveredTasks: conversation.taskId === null ? 0 : 1,
    deliveries: 1,
    oneTakeRate: shots.filter((shot) => shot.oneTake).length / shotCount,
    oneTakeShots: shots.filter((shot) => shot.oneTake).length,
    producers: 1,
    runs: 1 + (index % 3),
    shots: shotCount,
    tokensPerDelivery: usage.totalTokens,
    upstreamSeconds: { avg: 540, median: 540, p90: 600 },
    usage,
    videoSeconds: { avg: 600, median: 600, p90: 660 },
  }
  return {
    conversationId: conversation.id,
    deletedAt: conversation.deletedAt,
    deliveredAt: deliveredAt.toISOString(),
    metrics,
    ownerUserId: conversation.ownerUserId,
    shots,
    startedAt: new Date(deliveredAt.getTime() - cycleSeconds * 1000).toISOString(),
    taskId: conversation.taskId,
    title: conversation.title,
    usage: [{ modelName: 'claude-sonnet-5', usage }],
    userName: usernameOf(conversation.ownerUserId),
  }
}

const aggregate = (reports: Report[]): Metrics => {
  const sum = (pick: (m: Metrics) => number) =>
    reports.reduce((total, r) => total + pick(r.metrics), 0)
  const shots = sum((m) => m.shots)
  const attempts = sum((m) => m.attempts)
  const oneTakeShots = sum((m) => m.oneTakeShots)
  const usage = usageOf(
    sum((m) => m.usage.inputTokens),
    sum((m) => m.usage.cacheReadTokens),
    sum((m) => m.usage.cacheWriteTokens),
    sum((m) => m.usage.outputTokens),
    sum((m) => m.usage.requests),
  )
  const deliveredTasks = new Set(reports.flatMap((r) => (r.taskId === null ? [] : [r.taskId]))).size
  const orphans = reports.filter((r) => r.taskId === null).length
  const deliveries = deliveredTasks + orphans
  return {
    attempts,
    attemptsPerShot: shots === 0 ? null : attempts / shots,
    completedVideos: sum((m) => m.completedVideos),
    cycleSeconds: spread(reports.map((r) => r.metrics.cycleSeconds?.median ?? 0)),
    deliveredConversations: reports.length,
    deliveredOrphanConversations: orphans,
    deliveredTasks,
    deliveries,
    oneTakeRate: shots === 0 ? null : oneTakeShots / shots,
    oneTakeShots,
    producers: new Set(reports.map((r) => r.userName)).size,
    runs: sum((m) => m.runs),
    shots,
    tokensPerDelivery: deliveries === 0 ? null : usage.totalTokens / deliveries,
    upstreamSeconds: reports.length === 0 ? null : { avg: 540, median: 540, p90: 600 },
    usage,
    videoSeconds: reports.length === 0 ? null : { avg: 600, median: 600, p90: 660 },
  }
}

const inScope = (report: Report, query: URLSearchParams): boolean => {
  const since = query.get('since')
  const until = query.get('until')
  const userName = query.get('userName')
  const taskId = query.get('taskId')
  if (since !== null && report.deliveredAt < new Date(since).toISOString()) return false
  if (until !== null && report.deliveredAt >= new Date(until).toISOString()) return false
  if (userName !== null && report.userName !== userName) return false
  if (taskId !== null && report.taskId !== taskId) return false
  return true
}

/** 所有对话都当成出过片的，墓碑也算（治理者能读）。 */
const reportsFor = (query: URLSearchParams): Report[] =>
  mockConversations
    .map((conversation, index) => reportOf(conversation, index))
    .filter((report) => inScope(report, query))
    .sort((a, b) => b.deliveredAt.localeCompare(a.deliveredAt))

const periodStart = (iso: string, bucket: string, timeZone: string): string => {
  const at = new Date(iso)
  const parts = new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    month: '2-digit',
    timeZone,
    year: 'numeric',
  })
    .formatToParts(at)
    .filter((part) => part.type !== 'literal')
  const y = Number(parts.find((p) => p.type === 'year')?.value)
  const m = Number(parts.find((p) => p.type === 'month')?.value)
  const d = Number(parts.find((p) => p.type === 'day')?.value)
  const local = new Date(Date.UTC(y, m - 1, bucket === 'month' ? 1 : d))
  if (bucket === 'week') local.setUTCDate(local.getUTCDate() - ((local.getUTCDay() + 6) % 7))
  return local.toISOString()
}

/** 有界时间窗内每一期都列出来，和后端补空期的口径一致；不限时间没有起点，只留有数据的期。 */
const periodAxis = (query: URLSearchParams, bucket: string, timeZone: string): string[] => {
  const since = query.get('since')
  if (since === null) return []
  const until = query.get('until')
  const end = periodStart(
    new Date(new Date(until ?? Date.now()).getTime() - 1).toISOString(),
    bucket,
    timeZone,
  )
  const axis: string[] = []
  for (let at = new Date(periodStart(since, bucket, timeZone)); at.toISOString() <= end;) {
    axis.push(at.toISOString())
    at = new Date(at)
    if (bucket === 'month') at.setUTCMonth(at.getUTCMonth() + 1)
    else at.setUTCDate(at.getUTCDate() + (bucket === 'week' ? 7 : 1))
  }
  return axis
}

const anomaliesFor = (reports: Report[]): Anomaly[] => {
  const p90 = spread(reports.map((r) => r.metrics.cycleSeconds?.median ?? 0))?.p90 ?? 0
  const base = (report: Report) => ({
    conversationId: report.conversationId,
    generationId: null,
    shot: null,
    taskId: report.taskId,
    threshold: null,
    userName: report.userName,
    value: null,
  })
  const found: Anomaly[] = []
  for (const report of reports) {
    for (const shot of report.shots) {
      if (shot.attempts > 2) {
        found.push({
          ...base(report),
          at: shot.lastAt,
          kind: 'retry',
          shot: shot.shot,
          threshold: 2,
          value: shot.attempts,
        })
      }
    }
    const cycle = report.metrics.cycleSeconds?.median ?? 0
    if (reports.length >= 3 && cycle > p90) {
      found.push({
        ...base(report),
        at: report.deliveredAt,
        kind: 'slow',
        threshold: p90,
        value: cycle,
      })
    }
    if (report.taskId === null) {
      found.push({
        ...base(report),
        at: report.deliveredAt,
        kind: 'no_task',
        value: report.metrics.completedVideos,
      })
    }
    if (report.deletedAt !== null) {
      found.push({
        ...base(report),
        at: report.deletedAt,
        kind: 'deleted',
        value: report.metrics.completedVideos,
      })
    }
  }
  const stuck = reports[0]
  if (stuck !== undefined) {
    found.push({
      ...base(stuck),
      at: new Date(new Date(stuck.deliveredAt).getTime() - 3 * HOUR_MS).toISOString(),
      generationId: crypto.randomUUID(),
      kind: 'stuck',
      shot: 2,
      threshold: 1,
      value: 3.2,
    })
  }
  return found.sort((a, b) => b.at.localeCompare(a.at))
}

/** 出片次数分布：所有镜按次数分档，次数少的在前，不封顶。 */
const distributionOf = (reports: Report[]) => {
  const shotsAt = new Map<number, number>()
  for (const report of reports) {
    for (const shot of report.shots) {
      shotsAt.set(shot.attempts, (shotsAt.get(shot.attempts) ?? 0) + 1)
    }
  }
  return [...shotsAt.entries()]
    .sort(([a], [b]) => a - b)
    .map(([attempts, shots]) => ({ attempts, shots }))
}

const page = <T>(items: T[], query: URLSearchParams, key: (item: T) => string) => {
  const cursor = query.get('cursor')
  const limit = Number(query.get('limit') ?? 20)
  const start = cursor === null ? 0 : items.findIndex((item) => key(item) === cursor) + 1
  const slice = items.slice(start, start + limit)
  const last = slice.at(-1)
  return {
    items: slice,
    nextCursor: slice.length === limit && last !== undefined ? key(last) : null,
  }
}

export const auditHandlers = [
  http.get('*/api/audit/summary', ({ request }) => {
    const query = new URL(request.url).searchParams
    const reports = reportsFor(query)
    const bucket = query.get('bucket')
    const timeZone = query.get('timezone') ?? 'UTC'
    const byUser = new Map<string, Report[]>()
    const byTask = new Map<string, Report[]>()
    const byPeriod = new Map<string, Report[]>()
    for (const report of reports) {
      byUser.set(report.userName ?? '?', [...(byUser.get(report.userName ?? '?') ?? []), report])
      if (report.taskId !== null) {
        byTask.set(report.taskId, [...(byTask.get(report.taskId) ?? []), report])
      }
      if (bucket !== null) {
        const start = periodStart(report.deliveredAt, bucket, timeZone)
        byPeriod.set(start, [...(byPeriod.get(start) ?? []), report])
      }
    }
    if (bucket !== null) {
      for (const start of periodAxis(query, bucket, timeZone)) {
        if (!byPeriod.has(start)) byPeriod.set(start, [])
      }
    }
    const countByKind = new Map<string, number>()
    for (const anomaly of anomaliesFor(reports)) {
      countByKind.set(anomaly.kind, (countByKind.get(anomaly.kind) ?? 0) + 1)
    }
    return HttpResponse.json({
      anomalyCounts: [...countByKind.entries()]
        .sort(([kindA, countA], [kindB, countB]) => countB - countA || kindA.localeCompare(kindB))
        .map(([kind, count]) => ({ count, kind })),
      attemptDistribution: distributionOf(reports),
      overall: aggregate(reports),
      series:
        bucket === null
          ? null
          : [...byPeriod.entries()]
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([start, group]) => ({ metrics: aggregate(group), periodStart: start })),
      tasks: [...byTask.entries()].map(([taskId, group]) => ({
        metrics: aggregate(group),
        taskId,
        title: `需求单 ${taskId.slice(0, 4)}`,
      })),
      users: [...byUser.entries()]
        .map(([userName, group]) => ({ metrics: aggregate(group), userName }))
        .sort((a, b) => b.metrics.deliveries - a.metrics.deliveries),
    })
  }),

  http.get('*/api/audit/conversations', ({ request }) => {
    const query = new URL(request.url).searchParams
    return HttpResponse.json(
      page(reportsFor(query), query, (r) => `${r.deliveredAt}|${r.conversationId}`),
    )
  }),

  http.get('*/api/audit/anomalies', ({ request }) => {
    const query = new URL(request.url).searchParams
    const kinds = query.getAll('kind')
    const items = anomaliesFor(reportsFor(query)).filter(
      (item) => kinds.length === 0 || kinds.includes(item.kind),
    )
    return HttpResponse.json(
      page(items, query, (a) => `${a.at}|${a.kind}:${a.conversationId ?? ''}:${a.shot ?? ''}`),
    )
  }),
]
