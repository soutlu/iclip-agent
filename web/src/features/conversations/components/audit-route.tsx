/** 全平台对话列表：筛选由服务端执行，状态与总数由应用壳的全局订阅刷新。 */

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
  /** 需求单候选由路由层查询，feature 之间不直接互引。 */
  tasks: readonly TaskOption[]
  tasksPending?: boolean
  tasksError?: string | undefined
  onTasksRetry?: () => void
  taskFilterEnabled?: boolean
}

export function AuditRoute({
  tasks,
  tasksPending = false,
  tasksError,
  onTasksRetry,
  taskFilterEnabled = true,
}: AuditRouteProps) {
  const [filters, setFilters] = useState<AuditFilters>(DEFAULT_AUDIT_FILTERS)
  const directory = useUsersDirectory(true)
  const query = useAuditConversations(filters, true)
  const rows = query.data?.pages.flatMap((page) => page.items) ?? []
  const latest = query.data?.pages.at(-1)
  const totals =
    latest === undefined ? undefined : { runningTotal: latest.runningTotal, total: latest.total }
  const taskLabels = new Map(tasks.map((task) => [task.id, task.label]))

  return (
    <main
      aria-label="全部对话"
      className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-surface-container-lowest"
    >
      {/* 预留应用壳中侧栏展开按钮的空间。 */}
      <div className="mx-auto flex w-full max-w-360 flex-col gap-4 px-4 pt-12 pb-10 sm:gap-5 sm:px-7">
        <AuditFiltersBar
          filters={filters}
          onChange={setFilters}
          onTasksRetry={onTasksRetry}
          onUsersRetry={() => void directory.refetch()}
          taskFilterEnabled={taskFilterEnabled}
          tasks={tasks}
          tasksError={tasksError}
          tasksPending={tasksPending}
          totals={totals}
          users={directory.users}
          usersError={directory.error}
          usersPending={directory.isPending}
        />

        <section aria-label="对话列表" className="flex flex-col">
          {query.isPending ? (
            <p
              className="flex items-center justify-center gap-2 py-16 text-body text-on-surface-variant"
              role="status"
            >
              <Icon className="animate-spin" decorative name="loading" size="sm" />
              正在读取全部对话
            </p>
          ) : query.isError ? (
            <div className="flex flex-col items-center gap-3 py-16">
              <p className="text-body text-error" role="alert">
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
            <p className="py-16 text-center text-body text-on-surface-variant">
              这个筛选下没有对话
            </p>
          ) : (
            <ul className="flex flex-col">
              {rows.map((conversation) => (
                <AuditRow
                  conversation={conversation}
                  key={conversation.id}
                  ownerName={directory.nameOf(conversation.ownerUserId)}
                  taskLabel={
                    conversation.taskId === null ? undefined : taskLabels.get(conversation.taskId)
                  }
                />
              ))}
            </ul>
          )}

          {totals !== undefined && query.hasNextPage && rows.length > 0 ? (
            <footer className="flex items-center justify-between gap-4 px-3 py-4 text-body-sm text-on-surface-variant">
              <span>
                已显示 {rows.length} / {totals.total}
              </span>
              <Button
                disabled={query.isFetchingNextPage}
                leadingIcon="expand"
                onClick={() => void query.fetchNextPage()}
                size="md"
                variant="ghost"
              >
                {query.isFetchingNextPage ? '正在读取…' : '展开显示更多对话'}
              </Button>
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
  const status = conversationStatus(conversation.activity)
  return (
    <li className="border-b-[0.5px] border-border/70 last:border-b-0">
      <Link
        className={cn(
          'group flex min-h-20 ui-state items-center gap-3 rounded-md px-2 py-4 text-on-surface ui-focus sm:gap-4 sm:px-3',
          status === 'running' && 'bg-primary/4',
        )}
        params={{ conversationId: conversation.id }}
        to="/c/$conversationId"
      >
        <span
          aria-hidden
          className={cn(
            'grid size-8 shrink-0 place-items-center rounded-full bg-secondary-container/60 text-body font-medium text-on-secondary-container',
            status === 'running' && 'bg-primary/10 text-primary',
          )}
        >
          {owner.trim().charAt(0).toUpperCase()}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <span className="min-w-0 truncate text-title font-medium" title={conversation.title}>
              {conversation.title}
            </span>
            <ConversationStatusMark status={status} />
          </span>
          <span className="flex min-w-0 items-center gap-2 text-body-sm text-on-surface-variant">
            <span className="max-w-32 truncate" title={owner}>
              {owner}
            </span>
            <span aria-hidden>·</span>
            <time className="shrink-0" dateTime={conversation.updatedAt}>
              {formatRelativeTime(conversation.updatedAt)}
            </time>
            {taskLabel === undefined ? null : (
              <>
                <span aria-hidden>·</span>
                <span className="truncate" title={taskLabel}>
                  {taskLabel}
                </span>
              </>
            )}
          </span>
        </span>
        <Icon className="-rotate-90 text-on-surface-faint" decorative name="expand" size="sm" />
      </Link>
    </li>
  )
}

const STATUS_TAGS: Record<
  Exclude<ConversationStatus, 'idle' | 'completed'>,
  { icon: IconName; variant: 'soft' | 'running' | 'success' | 'error' }
> = {
  aborted: { icon: 'stopped', variant: 'soft' },
  approval: { icon: 'warning', variant: 'running' },
  failed: { icon: 'failed', variant: 'error' },
  question: { icon: 'warning', variant: 'running' },
  running: { icon: 'loading', variant: 'success' },
}

function ConversationStatusMark({ status }: { status: ConversationStatus }) {
  if (status === 'idle') return null
  const label = CONVERSATION_STATUS_LABELS[status]
  if (status === 'completed') {
    return (
      <span className="inline-flex shrink-0 text-primary" title={label}>
        <Icon decorative name="success" size="sm" />
        <span className="sr-only">{label}</span>
      </span>
    )
  }
  const tag = STATUS_TAGS[status]
  return (
    <Tag
      className={cn('shrink-0 rounded-full', status === 'running' && 'bg-primary/8 text-primary')}
      variant={tag.variant}
    >
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
