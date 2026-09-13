/** 治理者的全部对话页：全平台对话一行一段，筛选交给服务端，状态由全局帧就地刷新。 */

import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { useUsersDirectory } from '@/shared/auth'
import { Icon, type IconName } from '@/shared/icons'
import { formatRelativeTime } from '@/shared/lib/relative-time'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Tag } from '@/shared/ui/tag'
import { DEFAULT_AUDIT_FILTERS, useAuditConversations, type AuditFilters } from '../audit.api'
import {
  CONVERSATION_STATUS_LABELS,
  conversationStatus,
  type ConversationStatus,
} from '../conversation-status'
import type { Conversation } from '../conversations.api'
import { AuditFiltersBar, type TaskOption } from './audit-filters'

type AuditRouteProps = {
  /** 需求单候选由路由层取，feature 之间不直接互引。 */
  tasks: readonly TaskOption[]
}

// 状态、标题、属主、需求单、时间；窄屏收掉属主与需求单两列。
const ROW_GRID =
  'grid grid-cols-[108px_minmax(0,1fr)_88px] items-center gap-4 px-3 md:grid-cols-[108px_minmax(0,1fr)_160px_260px_88px]'

export function AuditRoute({ tasks }: AuditRouteProps) {
  const [filters, setFilters] = useState<AuditFilters>(DEFAULT_AUDIT_FILTERS)
  const { nameOf, users } = useUsersDirectory(true)
  const query = useAuditConversations(filters, true)
  const rows = query.data?.pages.flatMap((page) => page.items) ?? []
  const latest = query.data?.pages.at(-1)
  const totals =
    latest === undefined ? undefined : { runningTotal: latest.runningTotal, total: latest.total }
  const taskLabelOf = (taskId: string) => tasks.find((task) => task.id === taskId)?.label

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {/* 页头预留侧栏展开按钮的覆盖空间。 */}
      <div className="flex w-full flex-col gap-8 px-6 pt-14 pb-10">
        <header>
          <h1 className="text-headline font-semibold text-on-surface">全部对话</h1>
          <p className="mt-3 text-body text-on-surface-variant">
            全平台每一段对话此刻的状态；点进去能看，不能改
          </p>
        </header>

        <AuditFiltersBar
          filters={filters}
          onChange={setFilters}
          owners={users}
          tasks={tasks}
          totals={totals}
        />

        <section aria-label="对话列表" className="flex flex-col">
          <div
            aria-hidden
            className={cn(
              ROW_GRID,
              'h-9 border-b-[0.5px] border-border text-label text-on-surface-faint',
            )}
          >
            <span>状态</span>
            <span>对话</span>
            <span className="max-md:hidden">属主</span>
            <span className="max-md:hidden">需求单</span>
            <span className="text-right">最近活动</span>
          </div>

          {query.isPending ? (
            <p className="flex items-center gap-2 py-12 text-body-sm text-on-surface-variant">
              <Icon className="animate-spin" decorative name="loading" size="sm" />
              正在读取全部对话
            </p>
          ) : query.isError ? (
            <div className="flex flex-col items-start gap-3 py-12">
              <p className="text-body-sm text-error" role="alert">
                {query.error.message}
              </p>
              <Button
                leadingIcon="refresh"
                onClick={() => void query.refetch()}
                size="md"
                variant="outlined"
              >
                重新加载
              </Button>
            </div>
          ) : rows.length === 0 ? (
            <p className="py-12 text-body-sm text-on-surface-faint">这个筛选下没有对话</p>
          ) : (
            <ul className="flex flex-col py-1">
              {rows.map((conversation) => (
                <AuditRow
                  conversation={conversation}
                  key={conversation.id}
                  ownerName={nameOf(conversation.ownerUserId)}
                  taskLabel={
                    conversation.taskId === null ? undefined : taskLabelOf(conversation.taskId)
                  }
                />
              ))}
            </ul>
          )}

          {totals !== undefined && rows.length > 0 ? (
            <footer className="flex items-center justify-between gap-4 border-t-[0.5px] border-border px-3 py-3 text-body-sm text-on-surface-faint">
              <span>
                已显示 {rows.length} / {totals.total}
              </span>
              {query.hasNextPage ? (
                <Button
                  disabled={query.isFetchingNextPage}
                  leadingIcon="expand"
                  onClick={() => void query.fetchNextPage()}
                  size="md"
                  variant="ghost"
                >
                  {query.isFetchingNextPage ? '正在读取…' : '展开显示更多对话'}
                </Button>
              ) : null}
            </footer>
          ) : null}
        </section>
      </div>
    </main>
  )
}

type AuditRowProps = {
  conversation: Conversation
  ownerName: string | undefined
  taskLabel: string | undefined
}

function AuditRow({ conversation, ownerName, taskLabel }: AuditRowProps) {
  const owner = ownerName ?? '未知用户'
  return (
    <li>
      <Link
        className={cn(ROW_GRID, 'h-11 ui-state rounded-sm text-body text-on-surface ui-focus')}
        params={{ conversationId: conversation.id }}
        to="/c/$conversationId"
      >
        <StatusCell status={conversationStatus(conversation.activity)} />
        <span className="truncate">{conversation.title}</span>
        <span className="flex min-w-0 items-center gap-2 max-md:hidden">
          <span
            aria-hidden
            className="grid size-5 shrink-0 place-items-center rounded-full bg-secondary-container text-caption font-medium text-on-secondary-container"
          >
            {owner.trim().charAt(0).toUpperCase()}
          </span>
          <span className="truncate text-on-surface-variant">{owner}</span>
        </span>
        <span className="min-w-0 max-md:hidden">
          {taskLabel === undefined ? (
            <span className="text-on-surface-faint">—</span>
          ) : (
            <Tag className="max-w-full" variant="soft">
              <Icon decorative name="task" size="xs" />
              <span className="truncate">{taskLabel}</span>
            </Tag>
          )}
        </span>
        <time
          className="text-right text-label text-on-surface-faint"
          dateTime={conversation.updatedAt}
        >
          {formatRelativeTime(conversation.updatedAt)}
        </time>
      </Link>
    </li>
  )
}

const STATUS_TAGS: Record<
  Exclude<ConversationStatus, 'idle'>,
  { icon: IconName; variant: 'soft' | 'running' | 'success' | 'error' }
> = {
  aborted: { icon: 'stopped', variant: 'soft' },
  approval: { icon: 'warning', variant: 'running' },
  completed: { icon: 'success', variant: 'soft' },
  failed: { icon: 'failed', variant: 'error' },
  question: { icon: 'warning', variant: 'running' },
  running: { icon: 'loading', variant: 'success' },
}

/** 从没跑过的对话不贴标签，只淡淡写一句。 */
function StatusCell({ status }: { status: ConversationStatus }) {
  const label = CONVERSATION_STATUS_LABELS[status]
  if (status === 'idle') return <span className="text-label text-on-surface-faint">{label}</span>
  const tag = STATUS_TAGS[status]
  return (
    <Tag className="justify-self-start" variant={tag.variant}>
      <Icon
        className={cn(status === 'running' && 'animate-spin')}
        decorative
        name={tag.icon}
        size="xs"
      />
      {label}
    </Tag>
  )
}
