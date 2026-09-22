/** 全平台对话列表：筛选由服务端执行，条件存在地址栏由路由层下发，状态与总数由应用壳的全局订阅刷新。 */

import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useUsersDirectory } from '@/shared/auth'
import { Icon } from '@/shared/icons'
import { formatRelativeTime } from '@/shared/lib/relative-time'
import { Button } from '@/shared/ui/button'
import { MediaFallback } from '@/shared/ui/media-fallback'
import { StatusBadge } from '@/shared/ui/status-badge'
import { Tag } from '@/shared/ui/tag'
import { useAuditConversations, type AuditFilters } from '../audit.api'
import { conversationStatus } from '../conversation-status'
import type { Conversation } from '../conversations.api'
import { AuditFiltersBar } from './audit-filters'
import type { PickerSource } from '@/shared/ui/search-picker'

type TaskPreview = { title: string; requirement: string; imageUrl: string | null }
type TaskPreviewState = 'loading' | 'error' | 'ready' | 'forbidden'

type ConversationsRouteProps = {
  /** 当前筛选条件与写回，由路由层落在查询参数上。 */
  filters: AuditFilters
  onFiltersChange: (next: AuditFilters) => void
  /** 在本页点开某段对话，供路由层记下从哪一屏进去的；新标签页打开不算。 */
  onOpen?: (conversationId: string) => void
  /** 需求单候选由路由层查询，feature 之间不直接互引；null 表示当前账号没有 tasks:read 权限。 */
  tasks: PickerSource | null
  taskPreviews: ReadonlyMap<string, TaskPreview>
  taskPreviewState: TaskPreviewState
  taskPreviewRetry?: () => void
}

export function ConversationsRoute({
  filters,
  onFiltersChange,
  onOpen,
  tasks,
  taskPreviews,
  taskPreviewState,
  taskPreviewRetry,
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
      <div className="mx-auto flex w-full max-w-360 flex-col gap-6 px-4 pt-12 pb-10 sm:gap-8 sm:px-8">
        <header className="flex flex-col gap-2">
          <h1 className="text-headline-lg font-semibold tracking-tight text-on-surface">
            全部对话
          </h1>
          <p className="text-body text-on-surface-variant">
            查看所有用户的创作要求、运行状态与关联需求单
          </p>
        </header>
        <AuditFiltersBar
          filters={filters}
          onChange={onFiltersChange}
          tasks={tasks}
          totals={totals}
          users={users}
        />

        {taskPreviewState === 'error' ? (
          <div role="alert" className="flex flex-wrap items-center gap-3 text-body text-error">
            <span>部分需求单读取失败，已读取的内容仍可查看。</span>
            <Button onClick={taskPreviewRetry} size="md" variant="ghost">
              重新读取需求单
            </Button>
          </div>
        ) : null}
        <section aria-label="对话列表" className="flex flex-col">
          <div
            aria-hidden
            className="hidden grid-cols-[minmax(0,1fr)_6rem_8rem_10rem_5rem_1rem] gap-4 rounded-sm bg-surface-container-low px-4 py-3 text-body text-on-surface-variant xl:grid"
          >
            <span>创作内容</span>
            <span>属主</span>
            <span>关联需求单</span>
            <span>当前状态</span>
            <span>建立时间</span>
            <span />
          </div>
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
                  taskPreviewState={taskPreviewState}
                  taskPreview={
                    conversation.taskId === null ? undefined : taskPreviews.get(conversation.taskId)
                  }
                  taskLabel={
                    conversation.taskId === null ? undefined : taskLabels.get(conversation.taskId)
                  }
                />
              ))}
            </ul>
          )}

          {totals !== undefined && query.hasNextPage && rows.length > 0 ? (
            <footer className="flex items-center justify-between gap-4 px-3 py-4 text-body text-on-surface-variant">
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
  taskPreview: TaskPreview | undefined
  taskPreviewState: TaskPreviewState
}

const PREVIEW_TEXT: Record<TaskPreviewState, string> = {
  loading: '正在读取需求单…',
  error: '需求单信息暂不可用',
  forbidden: '无需求单查看权限',
  ready: '需求单暂不可用',
}

function AuditRow({
  conversation,
  onOpen,
  ownerName,
  taskLabel,
  taskPreview,
  taskPreviewState,
}: AuditRowProps) {
  const owner = ownerName ?? '未知用户'
  const status = conversationStatus(conversation.activity)
  const requirement =
    conversation.taskId === null
      ? '未关联需求单'
      : taskPreview === undefined
        ? PREVIEW_TEXT[taskPreviewState]
        : taskPreview.requirement.trim() || '未填写创作要求'
  const taskName =
    conversation.taskId === null
      ? '未关联'
      : (taskPreview?.title ?? taskLabel ?? PREVIEW_TEXT[taskPreviewState])
  return (
    <li className="border-b border-border/50 last:border-b-0">
      <Link
        className="group grid min-h-28 ui-state grid-cols-[minmax(0,1fr)_1rem] items-center gap-x-4 gap-y-3 rounded-sm px-3 py-4 text-on-surface ui-focus sm:px-4 xl:grid-cols-[minmax(0,1fr)_6rem_8rem_10rem_5rem_1rem]"
        onClick={(event) => {
          // 修饰键打开新标签页时，不改变当前页面的返回位置。
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
          onOpen?.(conversation.id)
        }}
        params={{ conversationId: conversation.id }}
        to="/c/$conversationId"
      >
        <span className="flex min-w-0 items-center gap-4">
          <AuditThumbnail
            key={taskPreview?.imageUrl ?? 'no-image'}
            url={taskPreview?.imageUrl ?? null}
            title={taskPreview?.title ?? conversation.title}
          />
          <span className="flex min-w-0 flex-1 flex-col gap-2">
            <span className="line-clamp-2 text-title font-semibold" title={conversation.title}>
              {conversation.title}
            </span>
            <span
              className="line-clamp-2 text-body leading-relaxed text-on-surface-variant"
              title={requirement}
            >
              {requirement}
            </span>
            {conversation.deletedAt === null ? null : (
              <span className="text-caption text-on-surface-variant">
                <Icon className="mr-1 inline" decorative name="delete" size="xs" />
                <time dateTime={conversation.deletedAt}>
                  已删除 · {formatRelativeTime(conversation.deletedAt)}
                </time>
              </span>
            )}
          </span>
        </span>
        <span className="col-start-1 flex min-w-0 items-center gap-2 text-body xl:col-start-auto">
          <span
            aria-hidden
            className="grid size-7 shrink-0 place-items-center rounded-full bg-secondary-container/60 text-caption text-on-secondary-container"
          >
            {owner.trim().charAt(0).toUpperCase()}
          </span>
          <span className="truncate" title={owner}>
            {owner}
          </span>
        </span>
        <span
          className="col-start-1 line-clamp-2 text-body text-on-surface-variant xl:col-start-auto"
          title={taskName}
        >
          <span className="xl:hidden">需求单： </span>
          {taskName}
        </span>
        <span className="col-start-1 flex flex-wrap items-start gap-2 xl:col-start-auto xl:flex-col">
          {status === 'idle' ? (
            // 从没跑过没有对应的角标，这一列仍要说出来。
            <span className="text-body text-on-surface-variant">暂无运行记录</span>
          ) : (
            <StatusBadge appearance="label" kind="conversation" status={status} />
          )}
          {conversation.activity.videoGeneration === 'none' ? null : (
            <StatusBadge
              appearance="label"
              kind="video"
              status={conversation.activity.videoGeneration}
            />
          )}
          {conversation.completedAt === null ? null : <Tag variant="soft">属主已收尾</Tag>}
        </span>
        <time
          className="col-start-1 text-body text-on-surface-variant xl:col-start-auto"
          dateTime={conversation.createdAt}
          title={new Date(conversation.createdAt).toLocaleString('zh-CN')}
        >
          <span className="xl:hidden">建立于 </span>
          {formatRelativeTime(conversation.createdAt)}
        </time>
        <Icon
          className="col-start-2 row-start-1 -rotate-90 text-on-surface-faint xl:col-start-auto xl:row-auto"
          decorative
          name="expand"
          size="sm"
        />
      </Link>
    </li>
  )
}

/** 图片只是需求素材；没有图片或加载失败时明确展示空态，不冒充生成产出。 */
function AuditThumbnail({ url, title }: { url: string | null; title: string }) {
  const [failed, setFailed] = useState(false)
  return (
    <span className="relative flex h-20 w-24 shrink-0 items-center justify-center overflow-hidden rounded-md bg-surface-container-low sm:h-20 sm:w-28">
      {url !== null && !failed ? (
        <img
          alt={`${title}的需求素材`}
          className="h-full w-full object-cover"
          loading="lazy"
          onError={() => setFailed(true)}
          src={url}
        />
      ) : failed ? (
        <MediaFallback className="text-on-surface-faint" kind="image" />
      ) : (
        <span className="flex flex-col items-center gap-2 text-on-surface-faint">
          <Icon decorative name="file" size="lg" />
          <span className="text-caption">暂无图片</span>
        </span>
      )}
    </span>
  )
}
