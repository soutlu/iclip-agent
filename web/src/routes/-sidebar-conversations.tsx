import { DndContext, PointerSensor, useDraggable, useDroppable, useSensor } from '@dnd-kit/core'
import type { DragEndEvent } from '@dnd-kit/core'
import { useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from '@tanstack/react-router'
import { useState } from 'react'
import {
  CollectionDeleteDialog,
  CollectionFormDialog,
  useCollections,
} from '@/features/collections'
import {
  ConversationMembershipDialog,
  conversationsQueryKeys,
  useDeleteConversation,
  useLiveConversations,
  useMoreConversations,
  useRenameConversation,
  useSetConversationMembership,
  useSidebarTopology,
  type Conversation,
  type ConversationListState,
  type ConversationPage,
  type SidebarCollection,
} from '@/features/conversations'
import { useTaskOptions } from '@/features/tasks'
import { Icon, type IconName } from '@/shared/icons'
import { formatRelativeTime } from '@/shared/lib/relative-time'
import { cn } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/button'
import { ChipGroup, FilterChip } from '@/shared/ui/chip'
import { MenuItem, MenuRoot, MenuSeparator, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
import { toast } from '@/shared/ui/toast'

// 侧栏各种行共用的外观。状态层铺在整行上（含行尾的钮），所以这个类挂在最外层容器，
// 里面的标题按钮只负责焦点环。
const ROW_CLASS =
  'group flex ui-state cursor-pointer items-center gap-2 rounded-sm px-3 py-1.5 text-body text-on-surface'

// 行里那个占满剩余宽度的标题按钮：不自带底色，hover 由外层行铺
const ROW_TITLE_CLASS = 'flex min-w-0 flex-1 items-center gap-2 rounded-xs ui-focus'

// 行尾槽：静息放时间、hover / 键盘聚焦 / 菜单展开时换成操作钮，两者不同时占位。
const ROW_TRAILING_HIDDEN =
  'group-hover:hidden group-focus-within:hidden group-has-data-[state=open]:hidden'
const ROW_TRAILING_SHOWN =
  'hidden group-hover:flex group-focus-within:flex group-has-data-[state=open]:flex'

// 合集列表一次露几个。合集是自己建的，后端一次就把（上限 100 个）全给了，
// 「展开显示」在前端切片，不为这点量再开一个翻页端点。
const COLLECTIONS_PER_STEP = 10

// 「任务」区的落点 id；合集的落点 id 是它自己的 uuid。
const UNGROUPED = 'ungrouped'

/**
 * 侧栏的对话区：顶部筛选 chip，「任务」（没进合集的）与「合集」两段。
 *
 * 三处列表都靠底部一行「展开显示」往下取：任务区与合集内走服务端翻页，合集列表本身
 * 在前端切片。对话可以拖进合集、拖回任务区、在合集之间互拖——落地后整块重拉，不做
 * 乐观更新（分页缓存里搬家不值那个复杂度）；键盘用户走行尾的归属弹窗，同一件事。
 *
 * @returns 对话区。
 */
export function SidebarConversations() {
  const queryClient = useQueryClient()
  const [state, setState] = useState<ConversationListState>('all')
  const topology = useSidebarTopology(true, state)
  // 全局帧就地改缓存里那一行，行只读自己身上的字段
  useLiveConversations()
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

  // 两处归属的候选项只在归属弹窗打开时才拉
  const collections = useCollections(membership.open)
  const tasks = useTaskOptions(membership.open)

  const refreshSidebar = () => {
    // 「展开显示」取回来的那些页整个丢掉：列表收回第一页，拓扑重拉一次即可，
    // 不必把每一页都重新请求一遍。
    queryClient.removeQueries({ queryKey: ['conversations', 'more'] })
    void queryClient.invalidateQueries({ queryKey: conversationsQueryKeys.sidebar() })
  }

  const moveMutation = useSetConversationMembership(refreshSidebar)
  // 距离阈值让「点一下」还是点击，不会被当成拖拽起手
  const pointer = useSensor(PointerSensor, { activationConstraint: { distance: 5 } })

  /**
   * 拖完松手，浏览器照样会在被拖那一行的链接上派一次 click；不拦掉的话，把对话拖进合集会顺带
   * 跳进会话页。
   *
   * 挡板挂在 document 上：落地之后侧栏会整块重拉，那一行连同挂在它上面的任何记号都已经换了
   * 一个，只有 document 活得过这一下。只吃「指向刚拖走那段对话」的那一次点击——落在别处的
   * 点击（比如紧接着去展开某个合集）必须照常放过去。
   */
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
    if (!over) return
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

  // 「进行中」那个 chip 上的圆点：这一段里有需要留意的会话就点亮（照 kimi）。只看拓扑这一份，
  // 「展开显示」取回的那些页在各自的子组件里。
  const anyBusy =
    (topology.data?.ungrouped.items ?? []).some((one) => one.activity.busy) ||
    allCollections.some((one) => one.page.items.some((row) => row.activity.busy))

  return (
    <DndContext
      onDragEnd={onDragEnd}
      onDragStart={({ active }) => setDragging(String(active.id))}
      sensors={[pointer]}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 pt-3 ui-state-subtle">
        <ChipGroup
          aria-label="对话筛选"
          // 再点一下当前那片，radix 会给空串——那是「取消选中」，这里没有这一档，忽略
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
          action={{
            icon: 'add',
            label: '新建合集',
            onClick: () => setCollectionForm({ open: true }),
          }}
          count={allCollections.length}
          title="合集"
        >
          {visibleCollections.map((collection) => (
            <CollectionGroup
              key={collection.id}
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

/**
 * 「任务」区：没进任何合集的对话，也是「把对话拖出合集」的落点。
 *
 * @param props - 总条数、第一页、当前筛选、拖拽中的对话 id、行内容变更后的刷新回调与打开归属弹窗的回调。
 * @returns 任务分区。
 */
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
  const { isOver, setNodeRef } = useDroppable({ id: UNGROUPED })
  const more = useMoreConversations({ state }, page.nextCursor)
  const items = [...page.items, ...(more.data?.pages.flatMap((one) => one.items) ?? [])]
  const hasMore = more.data ? more.hasNextPage : Boolean(page.nextCursor)

  // 整个分区（标题行也算）都是「拖出合集」的落点：拖到「任务」标题上等于拖回任务区
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
          {items.length === 0 && <EmptyHint>还没有对话</EmptyHint>}
          {hasMore && (
            <ExpandRow
              label="展开显示更多对话"
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
  /** 分区标题右侧的操作钮，缺省不渲染 */
  action?: { icon: IconName; label: string; onClick: () => void }
  children: React.ReactNode
  count: number
  title: string
}

/**
 * 侧栏分区：标题行（可折叠、带条数与可选操作钮）加下面的行。
 *
 * @param props - 标题、条数、操作钮与分区内容。
 * @returns 一个可折叠分区。
 */
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

/**
 * 列表底部那一行「展开显示」。它自己就是加载态：取的时候变「加载中…」并禁用，
 * 失败了变回来（错误文案由调用链上的 toast 出），不会消失——消失了就没得重试。
 *
 * @param props - 无障碍文案、加载态与点击回调。
 * @returns 展开行。
 */
function ExpandRow({
  label,
  loading = false,
  onExpand,
}: {
  label: string
  loading?: boolean
  onExpand: () => void
}) {
  return (
    <button
      aria-label={label}
      className={cn(ROW_CLASS, 'w-full justify-start text-body-sm text-on-surface-faint ui-focus')}
      disabled={loading}
      onClick={onExpand}
      type="button"
    >
      {loading ? '加载中…' : '展开显示'}
    </button>
  )
}

type CollectionGroupProps = {
  collection: SidebarCollection
  dragging: string | null
  onChanged: () => void
  onDelete: () => void
  onOpenMembership: (conversation: Conversation) => void
  onRename: () => void
  state: ConversationListState
}

/**
 * 合集行：文件夹图标 + 名字 + 总条数，展开后是它里面的对话；行尾菜单管改名与删除。
 * 整行也是拖拽落点——把对话拖上来就进这个合集。
 *
 * @param props - 合集、当前筛选、拖拽中的对话 id、改名/删除入口与打开归属弹窗的回调。
 * @returns 一个合集分组。
 */
function CollectionGroup({
  collection,
  dragging,
  onChanged,
  onDelete,
  onOpenMembership,
  onRename,
  state,
}: CollectionGroupProps) {
  const [open, setOpen] = useState(false)
  const { isOver, setNodeRef } = useDroppable({ id: collection.id })
  const more = useMoreConversations(
    { collectionId: collection.id, state },
    collection.page.nextCursor,
  )
  const items = [...collection.page.items, ...(more.data?.pages.flatMap((one) => one.items) ?? [])]
  const hasMore = more.data ? more.hasNextPage : Boolean(collection.page.nextCursor)

  return (
    <div className="flex flex-col gap-0.5">
      <div className={cn(ROW_CLASS, isOver && 'bg-primary-container')} ref={setNodeRef}>
        <button
          // 行内还有一个「操作」钮，名字里带上条数才好把两者分开念、也分得开
          aria-expanded={open}
          aria-label={`${collection.name} (${collection.conversationCount})`}
          className={ROW_TITLE_CLASS}
          onClick={() => setOpen((prev) => !prev)}
          type="button"
        >
          <Icon className="shrink-0 text-on-surface-variant" decorative name="folder" size="sm" />
          {/* 不加 flex-1：标题按内容占宽，折叠箭头才贴着名字走 */}
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
          {items.length === 0 && <EmptyHint>这个合集还是空的</EmptyHint>}
          {hasMore && (
            <ExpandRow
              label={`展开显示 ${collection.name} 里更多对话`}
              loading={more.isFetching}
              onExpand={() => void more.fetchNextPage()}
            />
          )}
        </div>
      )}
    </div>
  )
}

type RowStatus = 'approval' | 'question' | 'running' | 'failed' | 'idle'

/**
 * 行尾画哪一种状态，只看这一行身上的活儿。优先级照 kimi 写死：
 * 等审批 > 等回答 > 在跑 > 上次失败 > 空闲。
 *
 * @param activity - 列表行上的 `activity`，帧到了就地改过。
 * @returns 该画哪一种。
 */
const rowStatus = (activity: Conversation['activity']): RowStatus => {
  if (activity.pendingInteraction === 'approval') return 'approval'
  if (activity.pendingInteraction === 'question') return 'question'
  if (activity.busy) return 'running'
  if (activity.lastTurnReason === 'failed') return 'failed'
  return 'idle'
}

// 每种状态画成什么（design-system.html 结构模板里侧栏那一条）。`idle` 不在表里：什么都不画。
const ROW_STATUS_MARK: Record<
  Exclude<RowStatus, 'idle'>,
  { className: string; label: string; name: IconName }
> = {
  approval: { className: 'text-warning', label: '等待审批', name: 'warning' },
  failed: { className: 'text-chat-status-error', label: '上次失败', name: 'failed' },
  question: { className: 'text-warning', label: '等待回答', name: 'warning' },
  running: { className: 'animate-spin text-primary', label: '进行中', name: 'loading' },
}

/**
 * 对话行：截断标题在左，右侧是相对时间；hover / 键盘聚焦时时间让位给更多菜单。
 * 整行可拖。重命名是行内编辑：菜单里选「重命名」后标题换成输入框，
 * Enter / 失焦提交，Esc 取消。
 *
 * 名字与活儿都读这一行自己身上的字段——推送已经把缓存里那一行改过了。
 *
 * @param props - 对话、是否正被拖着、行内容变更后的刷新回调与打开归属弹窗的回调。
 * @returns 单个对话行。
 */
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
  const { listeners, setNodeRef, transform } = useDraggable({
    data: { collectionId: conversation.collectionId },
    id: conversation.id,
  })
  const openedId = useParams({ select: (params) => params.conversationId, strict: false })
  const active = openedId === conversation.id
  const [editing, setEditing] = useState(false)
  const rename = useRenameConversation(onChanged)
  const remove = useDeleteConversation(onChanged)
  const status = rowStatus(conversation.activity)
  const mark = status === 'idle' ? undefined : ROW_STATUS_MARK[status]

  // 空标题或没变化都不发请求，静默退回原标题
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
    // 拖拽挂在整行上而不是标题上：标题是链接，浏览器自带的链接拖拽会吞掉指针事件，
    // dnd-kit 那套拖拽从此不成立。行内编辑时不挂——不然在输入框里划选文字就变成拖行。
    <div
      className={cn(ROW_CLASS, dragging && 'opacity-50', active && 'bg-state-active font-medium')}
      ref={setNodeRef}
      style={
        transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : undefined
      }
      {...(editing ? {} : listeners)}
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
      {/* 状态标识一直露着（不像时间那样 hover 时让位）——它是这一行此刻最要紧的事。 */}
      {mark && (
        <Icon
          className={cn('shrink-0', mark.className)}
          label={mark.label}
          name={mark.name}
          size="xs"
        />
      )}
      {/* aria-hidden：可访问名只留标题，时间纯装饰 */}
      {!editing && (
        <span
          aria-hidden
          className={cn('shrink-0 text-caption text-on-surface-faint', ROW_TRAILING_HIDDEN)}
        >
          {formatRelativeTime(conversation.updatedAt)}
        </span>
      )}
      {/* 行内编辑时不露操作钮 */}
      {!editing && (
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
