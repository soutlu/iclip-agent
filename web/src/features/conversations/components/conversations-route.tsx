/** 全平台对话列表：筛选由服务端执行，条件存在地址栏由路由层下发，状态与总数由应用壳的全局订阅刷新。 */

import { Link } from '@tanstack/react-router'
import { useUsersDirectory } from '@/shared/auth'
import { Icon } from '@/shared/icons'
import { formatRelativeTime } from '@/shared/lib/relative-time'
import { Button } from '@/shared/ui/button'
import { StatusBadge } from '@/shared/ui/status-badge'
import { Tag } from '@/shared/ui/tag'
import { useAuditConversations, type AuditFilters } from '../audit.api'
import { conversationStatus } from '../conversation-status'
import type { Conversation } from '../conversations.api'
import { AuditFiltersBar } from './audit-filters'
import type { PickerSource } from '@/shared/ui/search-picker'

type ConversationsRouteProps = {
  /** 当前筛选条件与写回，由路由层落在查询参数上。 */
  filters: AuditFilters
  onFiltersChange: (next: AuditFilters) => void
  /** 在本页点开某段对话，供路由层记下从哪一屏进去的；新标签页打开不算。 */
  onOpen?: (conversationId: string) => void
  /** 需求单候选由路由层查询，feature 之间不直接互引；null 表示当前账号没有 tasks:read 权限。 */
  tasks: PickerSource | null
}

export function ConversationsRoute({
  filters,
  onFiltersChange,
  onOpen,
  tasks,
}: ConversationsRouteProps) {
  const directory = useUsersDirectory(true)
  const users: PickerSource = {
    error: directory.error,
    isPending: directory.isPending,
    onRetry: () => void directory.refetch(),
    options: directory.users.map((user) => ({ id: user.id, label: user.displayName })),
  }
  const query = useAuditConversations(filters, true)
  const rows = query.data?.pages.flatMap((page) => page.items) ?? []
  const latest = query.data?.pages.at(-1)
  const totals =
    latest === undefined ? undefined : { runningTotal: latest.runningTotal, total: latest.total }
  const taskLabels = new Map((tasks?.options ?? []).map((task) => [task.id, task.label]))

  return (
    <main
      aria-label="全部对话"
      className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-surface-container-lowest"
    >
      {/* 预留应用壳中侧栏展开按钮的空间。 */}
      <div className="mx-auto flex w-full max-w-360 flex-col gap-4 px-4 pt-12 pb-10 sm:gap-5 sm:px-7">
        <AuditFiltersBar
          filters={filters}
          onChange={onFiltersChange}
          tasks={tasks}
          totals={totals}
          users={users}
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
                  onOpen={onOpen}
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
  onOpen: ((conversationId: string) => void) | undefined
  ownerName: string | undefined
  taskLabel: string | undefined
}

function AuditRow({ conversation, onOpen, ownerName, taskLabel }: AuditRowProps) {
  const owner = ownerName ?? '未知用户'
  const status = conversationStatus(conversation.activity)
  return (
    <li className="border-b-[0.5px] border-border/70 last:border-b-0">
      <Link
        className="group flex min-h-20 ui-state items-center gap-3 rounded-md px-2 py-4 text-on-surface ui-focus sm:gap-4 sm:px-3"
        onClick={(event) => {
          // 带修饰键是在新标签页打开，本页仍停在列表，不算从这一屏点进去了。
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
          onOpen?.(conversation.id)
        }}
        params={{ conversationId: conversation.id }}
        to="/c/$conversationId"
      >
        <span
          aria-hidden
          className="grid size-8 shrink-0 place-items-center rounded-full bg-secondary-container/60 text-body font-medium text-on-secondary-container"
        >
          {owner.trim().charAt(0).toUpperCase()}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <span className="min-w-0 truncate text-title font-medium" title={conversation.title}>
              {conversation.title}
            </span>
            {/* 多数行是已完成，只给个对勾；其余状态带文字直接读出来。 */}
            <StatusBadge
              appearance={status === 'completed' ? 'icon' : 'label'}
              kind="conversation"
              status={status}
            />
            {conversation.deletedAt === null ? null : (
              <Tag variant="soft">
                <Icon decorative name="delete" size="xs" />
                <time dateTime={conversation.deletedAt}>
                  已删除 · {formatRelativeTime(conversation.deletedAt)}
                </time>
              </Tag>
            )}
          </span>
          <span className="flex min-w-0 items-center gap-2 text-body-sm text-on-surface-variant">
            <span className="max-w-32 truncate" title={owner}>
              {owner}
            </span>
            <span aria-hidden>·</span>
            <time className="shrink-0" dateTime={conversation.createdAt}>
              {formatRelativeTime(conversation.createdAt)}
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
