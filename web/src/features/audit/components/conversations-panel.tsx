/** 对话明细：有成片的对话一行一段，展开看镜头带与按模型的用量；最后成片晚的排前面。 */

import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import { Icon } from '@/shared/icons'
import { formatDateTime } from '@/shared/lib/date-time'
import { cn } from '@/shared/lib/utils'
import { ListEmpty, ListError, ListPending, LoadMoreFooter } from '@/shared/ui/list-state'
import { Tag } from '@/shared/ui/tag'
import { useAuditConversationReports, type AuditScope, type ConversationReport } from '../audit.api'
import { formatCount, formatDuration, formatRate, formatTimes, formatTokens } from '../format'
import { ShotStrip } from './shot-strip'

type ConversationsPanelProps = {
  scope: AuditScope
  nameOf: (userName: string) => string | undefined
  taskTitleOf: (taskId: string) => string | undefined
}

export function ConversationsPanel({ scope, nameOf, taskTitleOf }: ConversationsPanelProps) {
  const query = useAuditConversationReports(scope)
  const rows = query.data?.pages.flatMap((page) => page.items) ?? []

  if (query.isPending) return <ListPending label="正在读取对话明细" />
  if (query.isError) {
    return (
      <ListError
        message={errorMessageOf(query.error, '读取对话明细失败')}
        onRetry={() => void query.refetch()}
      />
    )
  }
  if (rows.length === 0) return <ListEmpty>这个范围里没有出过片的对话</ListEmpty>

  return (
    <section
      aria-label="对话明细"
      className="flex flex-col rounded-lg bg-surface-container-lowest shadow-[var(--shadow-1)]"
    >
      <div className="hidden grid-cols-[minmax(0,2fr)_repeat(5,minmax(0,1fr))_2rem] gap-3 px-5 py-2 text-body-sm text-on-surface-variant lg:grid">
        <span>对话</span>
        <span className="text-right">成片</span>
        <span className="text-right">每镜次数</span>
        <span className="text-right">一次通过</span>
        <span className="text-right">交付周期</span>
        <span className="text-right">token</span>
        <span />
      </div>
      <ul className="flex flex-col">
        {rows.map((report) => (
          <ConversationRow
            key={report.conversationId}
            nameOf={nameOf}
            report={report}
            taskTitleOf={taskTitleOf}
          />
        ))}
      </ul>
      {query.hasNextPage ? (
        <LoadMoreFooter
          isFetching={query.isFetchingNextPage}
          label="显示更多对话"
          onMore={() => void query.fetchNextPage()}
        />
      ) : null}
    </section>
  )
}

type ConversationRowProps = {
  report: ConversationReport
  nameOf: (userName: string) => string | undefined
  taskTitleOf: (taskId: string) => string | undefined
}

function ConversationRow({ report, nameOf, taskTitleOf }: ConversationRowProps) {
  const [open, setOpen] = useState(false)
  const person = report.userName === null ? '未知' : (nameOf(report.userName) ?? report.userName)
  const task = report.taskId === null ? null : (taskTitleOf(report.taskId) ?? '需求单')
  const { metrics } = report

  return (
    <li className="border-t-[0.5px] border-border/70">
      <div className="grid grid-cols-[minmax(0,1fr)_2rem] items-center gap-3 px-5 py-3 lg:grid-cols-[minmax(0,2fr)_repeat(5,minmax(0,1fr))_2rem]">
        <div className="flex min-w-0 flex-col gap-1">
          <Link
            className="min-w-0 truncate text-body font-medium text-on-surface ui-focus hover:underline"
            params={{ conversationId: report.conversationId }}
            title={report.title}
            to="/c/$conversationId"
          >
            {report.title}
          </Link>
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-body-sm text-on-surface-variant">
            <span className="truncate">{person}</span>
            {task === null ? (
              <Tag variant="soft">没挂需求单</Tag>
            ) : (
              <>
                <span aria-hidden>·</span>
                <span className="truncate" title={task}>
                  {task}
                </span>
              </>
            )}
            <span aria-hidden>·</span>
            <time dateTime={report.deliveredAt}>{formatDateTime(report.deliveredAt)} 成片</time>
            {report.deletedAt === null ? null : (
              <Tag variant="soft">
                <Icon decorative name="delete" size="xs" />
                已删除
              </Tag>
            )}
          </span>
          <dl className="flex flex-wrap gap-x-4 gap-y-1 text-body-sm text-on-surface-variant lg:hidden">
            <Stat label="成片" value={formatCount(metrics.completedVideos)} />
            <Stat label="每镜" value={formatTimes(metrics.attemptsPerShot)} />
            <Stat label="一次通过" value={formatRate(metrics.oneTakeRate)} />
            <Stat label="周期" value={formatDuration(metrics.cycleSeconds?.median ?? null)} />
            <Stat label="token" value={formatTokens(metrics.usage.totalTokens)} />
          </dl>
        </div>
        <Cell>{formatCount(metrics.completedVideos)}</Cell>
        {/* 整段对话的平均每镜次数，与镜头带按单镜判定的「重试过多」阈值不是同一口径。 */}
        <Cell emphasis={metrics.attemptsPerShot !== null && metrics.attemptsPerShot > 2}>
          {formatTimes(metrics.attemptsPerShot)}
        </Cell>
        <Cell>{formatRate(metrics.oneTakeRate)}</Cell>
        <Cell>{formatDuration(metrics.cycleSeconds?.median ?? null)}</Cell>
        <Cell>{formatTokens(metrics.usage.totalTokens)}</Cell>
        <button
          aria-expanded={open}
          aria-label={open ? '收起镜头明细' : '展开镜头明细'}
          className="grid size-8 ui-state cursor-pointer place-items-center rounded-full text-on-surface-variant ui-focus"
          onClick={() => setOpen((value) => !value)}
          type="button"
        >
          <Icon
            className={cn('ui-motion-s', open && 'rotate-180')}
            decorative
            name="expand"
            size="sm"
          />
        </button>
      </div>
      {open ? (
        <div className="flex flex-col gap-3 border-t-[0.5px] border-border/50 bg-surface-container-low/60 px-5 py-4">
          <ShotStrip shots={report.shots} />
          {report.usage.length === 0 ? (
            <p className="text-body-sm text-on-surface-variant">没有记到模型用量</p>
          ) : (
            <ul aria-label="按模型用量" className="flex flex-wrap gap-x-6 gap-y-1 text-body-sm">
              {report.usage.map((item) => (
                <li className="flex items-baseline gap-2" key={item.modelName}>
                  <span className="font-mono text-on-surface-variant">{item.modelName}</span>
                  <span className="text-on-surface tabular-nums">
                    {formatTokens(item.usage.totalTokens)}
                  </span>
                  <span className="text-on-surface-variant tabular-nums">
                    缓存 {formatRate(item.usage.cacheHitRate)} · {formatCount(item.usage.requests)}{' '}
                    次
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </li>
  )
}

function Cell({ children, emphasis = false }: { children: string; emphasis?: boolean }) {
  return (
    <span
      className={cn(
        'hidden text-right text-body tabular-nums lg:block',
        emphasis ? 'font-medium text-error' : 'text-on-surface',
      )}
    >
      {children}
    </span>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-1">
      <dt>{label}</dt>
      <dd className="text-on-surface tabular-nums">{value}</dd>
    </div>
  )
}
