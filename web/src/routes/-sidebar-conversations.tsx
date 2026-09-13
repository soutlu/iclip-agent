import { DndContext, PointerSensor, useDraggable, useDroppable, useSensor } from '@dnd-kit/core'
import type { DragEndEvent } from '@dnd-kit/core'
import { useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import {
  CollectionDeleteDialog,
  CollectionFormDialog,
  useCollections,
} from '@/features/collections'
import {
  CONVERSATION_STATUS_MARKS,
  ConversationMembershipDialog,
  conversationStatus,
  conversationsQueryKeys,
  useDeleteConversation,
  useMoreConversations,
  useRenameConversation,
  recordSeenRun,
  useSeenRun,
  useSetConversationMembership,
  useSidebarTopology,
  type Conversation,
  type ConversationListState,
  type ConversationPage,
  type SidebarCollection,
  type SidebarTopology,
} from '@/features/conversations'
import { useTaskOptions } from '@/features/tasks'
import { ApiError } from '@/shared/api/client'
import { useUser } from '@/shared/auth'
import { Icon, type IconName } from '@/shared/icons'
import { formatRelativeTime } from '@/shared/lib/relative-time'
import { cn } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/button'
import { ChipGroup, FilterChip } from '@/shared/ui/chip'
import { MenuItem, MenuRoot, MenuSeparator, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
import { toast } from '@/shared/ui/toast'

// 状态层作用于整行及尾部按钮；内部标题按钮只负责焦点环。
const ROW_CLASS =
  'group flex ui-state cursor-pointer items-center gap-2 rounded-sm px-3 py-1.5 text-body text-on-surface'

const ROW_TITLE_CLASS = 'flex min-w-0 flex-1 items-center gap-2 rounded-xs ui-focus'

// 时间与操作按钮共用尾部槽位，hover、键盘聚焦或菜单展开时切换。
const ROW_TRAILING_HIDDEN =
  'group-hover:hidden group-focus-within:hidden group-has-data-[state=open]:hidden'
const ROW_TRAILING_SHOWN =
  'hidden group-hover:flex group-focus-within:flex group-has-data-[state=open]:flex'

// 合集列表在前端分页展示；后端最多返回 100 个合集。
const COLLECTIONS_PER_STEP = 10

// 任务区使用固定落点 ID，合集使用自身 UUID。
const UNGROUPED = 'ungrouped'

/** 改对话（重命名、删除、拖动归属）要有 agent:run；用到的组件自己读，不逐层传。 */
const useCanWrite = () => (useUser().data?.permissions ?? []).includes('agent:run')

/** 任务区和合集内容使用服务端分页，合集列表在前端切片；拖动成功后刷新拓扑。 */
export function SidebarConversations() {
  const queryClient = useQueryClient()
  const session = useUser()
  const permissions = session.data?.permissions ?? []
  const canRead = permissions.includes('agent:read')
  const canWrite = useCanWrite()
  const canManageCollections = permissions.includes('collections:write')
  const canReadCollections = permissions.includes('collections:read')
  const canReadTasks = permissions.includes('tasks:read')
  const [state, setState] = useState<ConversationListState>('all')
  const topology = useSidebarTopology(canRead, state)
  useRecordOpened(topology.data)
  const [shownCollections, setShownCollections] = useState(COLLECTIONS_PER_STEP)
  const [dragging, setDragging] = useState<string | null>(null)

  const [collectionForm, setCollectionForm] = useState<{
    collection?: { id: string; name: string }
    open: boolean
  }>({ open: false })
  const [collectionDelete, setCollectionDelete] = useState<{
    collection?: { id: string; name: string }
    open: boolean
  }>({ open: false })
  const [membership, setMembership] = useState<{
    conversation?: Conversation
    open: boolean
  }>({ open: false })

  const collections = useCollections(membership.open && canReadCollections)
  const tasks = useTaskOptions(membership.open && canReadTasks)

  const refreshSidebar = () => {
    // 拓扑刷新时丢弃额外分页，避免每个已加载页分别重新请求。
    queryClient.removeQueries({ queryKey: conversationsQueryKeys.moreAll })
    void queryClient.invalidateQueries({ queryKey: conversationsQueryKeys.sidebar() })
  }

  const moveMutation = useSetConversationMembership(refreshSidebar)
  const pointer = useSensor(PointerSensor, { activationConstraint: { distance: 5 } })

  /** 在 document 上拦截拖动结束后指向原对话的一次 click；行可能已重建，行级监听无法可靠阻止误跳转。 */
  const swallowClickAfterDrag = (conversationId: string) => {
    document.addEventListener(
      'click',
      (event) => {
        const link = event.target instanceof Element ? event.target.closest('a') : null
        if (link?.getAttribute('href')?.endsWith(conversationId) !== true) return
        event.preventDefault()
        event.stopPropagation()
      },
      { capture: true, once: true },
    )
  }

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    setDragging(null)
    swallowClickAfterDrag(String(active.id))
    if (!canWrite || !over) return
    const from = (active.data.current as { collectionId: string | null } | undefined)?.collectionId
    const to = over.id === UNGROUPED ? null : String(over.id)
    if (from === to) return
    moveMutation.mutate(
      { collectionId: to, conversationId: String(active.id) },
      { onError: () => toast.error('移动失败，请重试') },
    )
  }

  const allCollections: readonly SidebarCollection[] = topology.data?.collections ?? []
  const visibleCollections = allCollections.slice(0, shownCollections)

  // 运行筛选的指示点仅取拓扑首页数据，额外分页由子组件持有。
  const anyBusy =
    (topology.data?.ungrouped.items ?? []).some((one) => one.activity.busy) ||
    allCollections.some((one) => one.page.items.some((row) => row.activity.busy))

  if (session.isPending) return <SidebarFeedback>正在确认登录状态…</SidebarFeedback>
  if (session.isError)
    return (
      <SidebarFeedback error loading={session.isFetching} onRetry={() => void session.refetch()}>
        读取登录状态失败
      </SidebarFeedback>
    )
  if (!canRead) return <SidebarFeedback>当前账号没有查看对话权限</SidebarFeedback>
  if (topology.isPending) return <SidebarFeedback>正在加载对话…</SidebarFeedback>
  if (topology.isError)
    return (
      <SidebarFeedback error loading={topology.isFetching} onRetry={() => void topology.refetch()}>
        {topology.error instanceof ApiError && topology.error.status === 403
          ? '当前账号没有查看对话权限'
          : topology.error instanceof ApiError
            ? topology.error.message
            : '读取对话列表失败，请重试'}
      </SidebarFeedback>
    )

  return (
    <DndContext
      onDragEnd={onDragEnd}
      onDragStart={({ active }) => setDragging(String(active.id))}
      sensors={[pointer]}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 pt-3 ui-state-subtle">
        <ChipGroup
          aria-label="对话筛选"
          // 忽略 Radix 取消当前选项产生的空串，保持筛选始终有值。
          onValueChange={(value) => value && setState(value as ConversationListState)}
          type="single"
          value={state}
        >
          <FilterChip value="all">全部</FilterChip>
          <FilterChip value="running">
            进行中
            {anyBusy && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-primary" />}
          </FilterChip>
          <FilterChip value="done">已完成</FilterChip>
        </ChipGroup>

        <UngroupedSection
          count={topology.data?.ungroupedCount ?? 0}
          dragging={dragging}
          onChanged={refreshSidebar}
          onOpenMembership={(conversation) => setMembership({ conversation, open: true })}
          page={topology.data?.ungrouped ?? { items: [], nextCursor: null }}
          state={state}
        />

        <SidebarSection
          action={
            canManageCollections
              ? {
                  icon: 'add',
                  label: '新建合集',
                  onClick: () => setCollectionForm({ open: true }),
                }
              : undefined
          }
          count={allCollections.length}
          title="合集"
        >
          {visibleCollections.map((collection) => (
            <CollectionGroup
              key={collection.id}
              canManage={canManageCollections}
              collection={collection}
              dragging={dragging}
              onChanged={refreshSidebar}
              onDelete={() =>
                setCollectionDelete({
                  collection: { id: collection.id, name: collection.name },
                  open: true,
                })
              }
              onOpenMembership={(conversation) => setMembership({ conversation, open: true })}
              onRename={() =>
                setCollectionForm({
                  collection: { id: collection.id, name: collection.name },
                  open: true,
                })
              }
              state={state}
            />
          ))}
          {allCollections.length === 0 && <EmptyHint>还没有合集</EmptyHint>}
          {allCollections.length > visibleCollections.length && (
            <ExpandRow
              label="展开显示更多合集"
              retryLabel="重试加载更多合集"
              onExpand={() => setShownCollections((shown) => shown + COLLECTIONS_PER_STEP)}
            />
          )}
        </SidebarSection>
      </div>

      <CollectionFormDialog
        collection={collectionForm.collection}
        onOpenChange={(open) => setCollectionForm((prev) => ({ ...prev, open }))}
        onSaved={refreshSidebar}
        open={collectionForm.open}
      />
      <CollectionDeleteDialog
        collection={collectionDelete.collection}
        onDeleted={refreshSidebar}
        onOpenChange={(open) => setCollectionDelete((prev) => ({ ...prev, open }))}
        open={collectionDelete.open}
      />
      <ConversationMembershipDialog
        collectionUnavailable={
          !canReadCollections
            ? '当前账号没有查看合集权限'
            : collections.isPending
              ? '正在加载合集…'
              : collections.isError
                ? '读取合集失败，请重试'
                : undefined
        }
        taskUnavailable={
          !canReadTasks
            ? '当前账号没有查看需求单权限'
            : tasks.isPending
              ? '正在加载需求单…'
              : tasks.isError
                ? '读取需求单失败，请重试'
                : undefined
        }
        {...(canReadCollections && collections.isError
          ? { onRetryCollections: () => void collections.refetch() }
          : {})}
        {...(canReadTasks && tasks.isError ? { onRetryTasks: () => void tasks.refetch() } : {})}
        collectionOptions={(collections.data ?? []).map((item) => ({
          id: item.id,
          label: item.name,
        }))}
        conversation={membership.conversation}
        onOpenChange={(open) => setMembership((prev) => ({ ...prev, open }))}
        onSaved={refreshSidebar}
        open={membership.open}
        taskOptions={tasks.data ?? []}
      />
    </DndContext>
  )
}

function UngroupedSection({
  count,
  dragging,
  onChanged,
  onOpenMembership,
  page,
  state,
}: {
  count: number
  dragging: string | null
  onChanged: () => void
  onOpenMembership: (conversation: Conversation) => void
  page: ConversationPage
  state: ConversationListState
}) {
  const canWrite = useCanWrite()
  const { isOver, setNodeRef } = useDroppable({ id: UNGROUPED, disabled: !canWrite })
  const more = useMoreConversations({ state }, page.nextCursor)
  const items = uniqueConversations([
    ...page.items,
    ...(more.data?.pages.flatMap((one) => one.items) ?? []),
  ])
  const hasMore = more.data ? more.hasNextPage : Boolean(page.nextCursor)

  return (
    <div className={cn('rounded-sm', isOver && 'bg-surface-container-high')} ref={setNodeRef}>
      <SidebarSection count={count} title="任务">
        <div className="flex flex-col gap-0.5">
          {items.map((conversation) => (
            <ConversationRow
              key={conversation.id}
              conversation={conversation}
              dragging={dragging === conversation.id}
              onChanged={onChanged}
              onOpenMembership={() => onOpenMembership(conversation)}
            />
          ))}
          {items.length === 0 && <EmptyHint>{emptyConversations(state)}</EmptyHint>}
          {hasMore && (
            <ExpandRow
              error={more.error}
              label="展开显示更多对话"
              retryLabel="重试加载更多对话"
              loading={more.isFetching}
              onExpand={() => void more.fetchNextPage()}
            />
          )}
        </div>
      </SidebarSection>
    </div>
  )
}

type SidebarSectionProps = {
  action?: { icon: IconName; label: string; onClick: () => void } | undefined
  children: React.ReactNode
  count: number
  title: string
}

function SidebarSection({ action, children, count, title }: SidebarSectionProps) {
  const [open, setOpen] = useState(true)
  return (
    <section className="flex flex-col gap-0.5">
      <div className={cn(ROW_CLASS, 'sticky top-0 gap-1 bg-background')}>
        <button
          aria-expanded={open}
          className={cn(ROW_TITLE_CLASS, 'gap-1 text-body-sm font-semibold text-on-surface-faint')}
          onClick={() => setOpen((prev) => !prev)}
          type="button"
        >
          <span className="min-w-0 truncate text-left">
            {title} ({count})
          </span>
          <Icon
            className={cn(
              'shrink-0 transition-transform duration-(--dur-s)',
              !open && '-rotate-90',
            )}
            decorative
            name="expand"
            size="sm"
          />
        </button>
        {action && (
          <div className={cn(ROW_TRAILING_SHOWN, 'ml-auto shrink-0 items-center')}>
            <IconButton
              label={action.label}
              name={action.icon}
              onClick={action.onClick}
              size="xs"
            />
          </div>
        )}
      </div>
      {open && <div className="flex flex-col gap-0.5">{children}</div>}
    </section>
  )
}

function EmptyHint({ children }: { children: string }) {
  return <p className="px-3 py-1 text-body-sm text-on-surface-faint">{children}</p>
}

function SidebarFeedback({
  children,
  error = false,
  loading = false,
  onRetry,
}: {
  children: string
  error?: boolean
  loading?: boolean
  onRetry?: () => void
}) {
  return (
    <div className="min-h-0 flex-1 px-3 pt-4">
      <p
        className={cn('text-body-sm', error ? 'text-error' : 'text-on-surface-faint')}
        role={error ? 'alert' : 'status'}
      >
        {children}
      </p>
      {onRetry && (
        <button
          className={cn(ROW_CLASS, 'mt-2 ui-focus')}
          disabled={loading}
          onClick={onRetry}
          type="button"
        >
          {loading ? '重试中…' : '重新加载对话'}
        </button>
      )}
    </div>
  )
}

const emptyConversations = (state: ConversationListState) =>
  state === 'running' ? '没有进行中的对话' : state === 'done' ? '没有已完成的对话' : '还没有对话'

/** 页边界可因活动时间变化重叠，保留首页优先的第一条记录。 */
const uniqueConversations = (items: readonly Conversation[]): Conversation[] => {
  const seen = new Set<string>()
  return items.filter((item) => {
    if (seen.has(item.id)) return false
    seen.add(item.id)
    return true
  })
}

/** 分页失败保留已加载内容，并在原入口显示原因和重试。 */
function ExpandRow({
  error,
  label,
  loading = false,
  onExpand,
  retryLabel,
}: {
  error?: unknown
  label: string
  loading?: boolean
  onExpand: () => void
  retryLabel: string
}) {
  return (
    <>
      {error != null && (
        <p className="px-3 py-1 text-body-sm text-error" role="alert">
          {error instanceof ApiError ? error.message : '加载更多对话失败，请重试'}
        </p>
      )}
      <button
        aria-label={error != null ? retryLabel : label}
        className={cn(
          ROW_CLASS,
          'w-full justify-start text-body-sm text-on-surface-faint ui-focus',
        )}
        disabled={loading}
        onClick={onExpand}
        type="button"
      >
        {loading ? '加载中…' : error != null ? '重试加载' : '展开显示'}
      </button>
    </>
  )
}

type CollectionGroupProps = {
  canManage: boolean
  collection: SidebarCollection
  dragging: string | null
  onChanged: () => void
  onDelete: () => void
  onOpenMembership: (conversation: Conversation) => void
  onRename: () => void
  state: ConversationListState
}

function CollectionGroup({
  canManage,
  collection,
  dragging,
  onChanged,
  onDelete,
  onOpenMembership,
  onRename,
  state,
}: CollectionGroupProps) {
  const [open, setOpen] = useState(false)
  const canWrite = useCanWrite()
  const { isOver, setNodeRef } = useDroppable({ id: collection.id, disabled: !canWrite })
  const more = useMoreConversations(
    { collectionId: collection.id, state },
    collection.page.nextCursor,
  )
  const items = uniqueConversations([
    ...collection.page.items,
    ...(more.data?.pages.flatMap((one) => one.items) ?? []),
  ])
  const hasMore = more.data ? more.hasNextPage : Boolean(collection.page.nextCursor)

  return (
    <div className="flex flex-col gap-0.5">
      <div className={cn(ROW_CLASS, isOver && 'bg-primary-container')} ref={setNodeRef}>
        <button
          aria-expanded={open}
          aria-label={`${collection.name} (${collection.conversationCount})`}
          className={ROW_TITLE_CLASS}
          onClick={() => setOpen((prev) => !prev)}
          type="button"
        >
          <Icon className="shrink-0 text-on-surface-variant" decorative name="folder" size="sm" />
          {/* 标题按内容占宽，使折叠箭头紧邻名称。 */}
          <span aria-hidden className="min-w-0 truncate text-left">
            {collection.name}
          </span>
          <Icon
            className={cn(
              'shrink-0 text-on-surface-variant transition-transform duration-(--dur-s)',
              !open && '-rotate-90',
            )}
            decorative
            name="expand"
            size="sm"
          />
        </button>
        {canManage && (
          <div className={cn(ROW_TRAILING_SHOWN, 'shrink-0 items-center')}>
            <MenuRoot>
              <MenuTrigger asChild>
                <IconButton label={`${collection.name} 的操作`} name="more" size="xs" />
              </MenuTrigger>
              <MenuSurface align="start">
                <MenuItem onSelect={onRename}>重命名</MenuItem>
                <MenuItem destructive onSelect={onDelete}>
                  删除
                </MenuItem>
              </MenuSurface>
            </MenuRoot>
          </div>
        )}
      </div>
      {open && (
        <div className="flex flex-col gap-0.5 pl-6">
          {items.map((conversation) => (
            <ConversationRow
              key={conversation.id}
              conversation={conversation}
              dragging={dragging === conversation.id}
              onChanged={onChanged}
              onOpenMembership={() => onOpenMembership(conversation)}
            />
          ))}
          {items.length === 0 && (
            <EmptyHint>
              {state === 'all' ? '这个合集还是空的' : emptyConversations(state)}
            </EmptyHint>
          )}
          {hasMore && (
            <ExpandRow
              error={more.error}
              label={`展开显示 ${collection.name} 里更多对话`}
              retryLabel={`重试加载 ${collection.name} 里更多对话`}
              loading={more.isFetching}
              onExpand={() => void more.fetchNextPage()}
            />
          )}
        </div>
      )}
    </div>
  )
}

/** 在拓扑层记录当前对话，避免折叠行未渲染时漏记；运行中记录 null，结束后记录 lastRunId。 */
const useRecordOpened = (topology: SidebarTopology | undefined): void => {
  const openedId = useParams({ select: (params) => params.conversationId, strict: false })
  const opened =
    openedId === undefined || topology === undefined ? undefined : findRow(topology, openedId)
  const seenRun = opened === undefined ? undefined : opened.activity.busy ? null : opened.lastRunId
  useEffect(() => {
    if (openedId !== undefined && seenRun !== undefined) recordSeenRun(openedId, seenRun)
  }, [openedId, seenRun])
}

const findRow = (topology: SidebarTopology, conversationId: string): Conversation | undefined =>
  [topology.ungrouped, ...topology.collections.map((one) => one.page)]
    .flatMap((page) => page.items)
    .find((row) => row.id === conversationId)

/** 仅对本浏览器已查看过且 lastRunId 变化的完成对话显示未读；当前打开的对话不显示。 */
const useUnread = (conversation: Conversation, active: boolean): boolean => {
  const seenRun = useSeenRun(conversation.id)
  return !active && seenRun !== undefined && seenRun !== conversation.lastRunId
}

function ConversationRow({
  conversation,
  dragging,
  onChanged,
  onOpenMembership,
}: {
  conversation: Conversation
  dragging: boolean
  onChanged: () => void
  onOpenMembership: () => void
}) {
  const canWrite = useCanWrite()
  const { listeners, setNodeRef, transform } = useDraggable({
    disabled: !canWrite,
    data: { collectionId: conversation.collectionId },
    id: conversation.id,
  })
  const openedId = useParams({ select: (params) => params.conversationId, strict: false })
  const active = openedId === conversation.id
  const [editing, setEditing] = useState(false)
  const rename = useRenameConversation(onChanged)
  const remove = useDeleteConversation(onChanged)
  const unread = useUnread(conversation, active)
  const status = conversationStatus(conversation.activity)
  // 行尾只画还需要人看一眼的状态；跑完没看过的用小点，其余什么都不画。
  const mark =
    status === 'approval' || status === 'question' || status === 'running' || status === 'failed'
      ? CONVERSATION_STATUS_MARKS[status]
      : undefined
  const showUnread = unread && status === 'completed'

  const commitRename = (value: string) => {
    setEditing(false)
    const title = value.trim()
    if (title && title !== conversation.title) {
      rename.mutate(
        { conversationId: conversation.id, title },
        { onError: (error) => toast.error(error.message) },
      )
    }
  }

  return (
    // 拖拽绑定整行，避免链接原生拖动吞掉指针事件；编辑标题时禁用拖拽以允许文字选择。
    <div
      className={cn(ROW_CLASS, dragging && 'opacity-50', active && 'bg-state-active font-medium')}
      ref={setNodeRef}
      style={
        transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : undefined
      }
      {...(editing || !canWrite ? {} : listeners)}
    >
      {editing ? (
        <input
          aria-label={`重命名 ${conversation.title}`}
          className="min-w-0 flex-1 rounded-xs bg-surface-container-lowest px-1 text-body text-on-surface ui-focus-inline"
          defaultValue={conversation.title}
          onBlur={(event) => commitRename(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
            if (event.key === 'Escape') {
              event.currentTarget.value = conversation.title
              event.currentTarget.blur()
            }
          }}
          ref={(element) => element?.focus()}
        />
      ) : (
        <Link
          aria-current={active ? 'page' : undefined}
          className={ROW_TITLE_CLASS}
          draggable={false}
          params={{ conversationId: conversation.id }}
          to="/c/$conversationId"
        >
          <span className="min-w-0 flex-1 truncate text-left">{conversation.title}</span>
        </Link>
      )}
      {mark && (
        <Icon
          className={cn('shrink-0', mark.className)}
          label={mark.label}
          name={mark.name}
          size="xs"
        />
      )}
      {showUnread && (
        <span aria-label="未读" className="size-1.5 shrink-0 rounded-full bg-primary" role="img" />
      )}
      {!editing && (
        <span
          aria-hidden
          className={cn('shrink-0 text-caption text-on-surface-faint', ROW_TRAILING_HIDDEN)}
        >
          {formatRelativeTime(conversation.updatedAt)}
        </span>
      )}
      {!editing && canWrite && (
        <div className={cn(ROW_TRAILING_SHOWN, 'shrink-0 items-center')}>
          <MenuRoot>
            <MenuTrigger asChild>
              <IconButton label={`${conversation.title} 的更多操作`} name="more" size="xs" />
            </MenuTrigger>
            <MenuSurface align="start">
              <MenuItem icon="edit" onSelect={() => setEditing(true)}>
                重命名
              </MenuItem>
              <MenuItem icon="folder" onSelect={onOpenMembership}>
                归属
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                destructive
                icon="delete"
                onSelect={() =>
                  remove.mutate(conversation.id, {
                    onError: (error) => toast.error(error.message),
                  })
                }
              >
                删除
              </MenuItem>
            </MenuSurface>
          </MenuRoot>
        </div>
      )}
    </div>
  )
}
