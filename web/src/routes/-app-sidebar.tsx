import { useQueryClient } from '@tanstack/react-query'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import { useState } from 'react'
import { CueUserMenu } from '@/features/auth'
import {
  CollectionDeleteDialog,
  CollectionFormDialog,
  useCollections,
} from '@/features/collections'
import {
  ConversationMembershipDialog,
  ConversationSearchDialog,
  conversationsQueryKeys,
  useSidebarTopology,
} from '@/features/conversations'
import { useTaskOptions } from '@/features/tasks'
import { useUser } from '@/shared/auth'
import { Icon, type IconName } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/button'
import { MenuItem, MenuRoot, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
import { useLoginPrompt } from './-login-prompt'

// 侧栏里几种行（操作行、对话行、合集行、未登录的登录行）共用的外观：幽灵行，
// hover / pressed 由 ui-state 铺，焦点走 ui-focus。宽度与内距由调用处按需覆盖。
const SIDEBAR_ROW_CLASS =
  'flex ui-state cursor-pointer items-center gap-2 rounded-sm px-2 py-2 ui-focus text-body text-on-surface'

type SidebarConversation = {
  collectionId: string | null
  id: string
  taskId: string | null
  title: string
}

/**
 * 应用侧栏：每页共享的外壳（品牌区、新建任务 / 搜索 / 需求单 / 资料库入口、对话区、账户区）。
 *
 * 对话区就是后端那份侧栏拓扑：「任务」是还没进合集的对话，「合集」是分好组的那些，
 * 每个合集可折叠、行尾显示条数。合集在这里新建、改名、删除；一段对话的两处归属
 * （在哪个合集、记在哪张需求单下）走同一个归属弹窗。未登录时对话区与账户区退成登录
 * 入口，点任何操作都弹登录框。
 *
 * @returns 侧栏与折叠态下的浮出展开按钮。
 */
export function AppSidebar() {
  // 紧凑屏（< --breakpoint-sm 600）默认收起，展开后成浮层；桌面默认展开、收入布局流
  const [collapsed, setCollapsed] = useState(() => !window.matchMedia('(min-width: 600px)').matches)
  const navigate = useNavigate()
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const [searchOpen, setSearchOpen] = useState(false)
  const { data: user } = useUser()
  const requireLogin = useLoginPrompt()
  const queryClient = useQueryClient()
  const topology = useSidebarTopology(Boolean(user))

  // 三个弹窗共用一套开关：同一时刻只会开一个
  const [collectionForm, setCollectionForm] = useState<{
    collection?: { id: string; name: string }
    open: boolean
  }>({ open: false })
  const [collectionDelete, setCollectionDelete] = useState<{
    collection?: { id: string; name: string }
    open: boolean
  }>({ open: false })
  const [membership, setMembership] = useState<{
    conversation?: SidebarConversation
    open: boolean
  }>({ open: false })

  // 两处归属的候选项只在归属弹窗打开时才拉
  const collections = useCollections(membership.open)
  const tasks = useTaskOptions(membership.open)

  const refreshSidebar = () => {
    void queryClient.invalidateQueries({ queryKey: conversationsQueryKeys.all })
  }

  if (collapsed) {
    return (
      <IconButton
        className="layer-sidebar fixed top-3 left-3 bg-surface-container-lowest shadow-[var(--shadow-1)]"
        label="展开侧边栏"
        name="panel-left"
        onClick={() => setCollapsed(false)}
        size="md"
      />
    )
  }

  return (
    <aside
      className={cn(
        'layer-sidebar flex h-dvh w-(--layout-app-sidebar-width) shrink-0 flex-col border-r border-border bg-background',
        'max-sm:fixed max-sm:top-0 max-sm:left-0 max-sm:shadow-[var(--shadow-2)] sm:sticky sm:top-0',
      )}
    >
      <div className="flex items-center gap-2 px-3 pt-3 pb-1">
        <span
          aria-hidden
          className="grid size-(--control-height-md) shrink-0 place-items-center rounded-md bg-primary font-home-display text-title font-semibold text-on-primary italic"
        >
          C
        </span>
        <span className="min-w-0 flex-1 truncate font-home-display text-title-lg font-semibold tracking-[-0.02em] text-on-surface italic">
          Cue
        </span>
        <IconButton
          label="折叠侧边栏"
          name="panel-left"
          onClick={() => setCollapsed(true)}
          size="md"
        />
      </div>

      <nav aria-label="会话操作" className="flex flex-col gap-0.5 px-2 pt-2">
        <SidebarAction
          icon="chat-new"
          kbd="⌘N"
          label="新建任务"
          onClick={user ? () => navigate({ to: '/' }) : requireLogin}
        />
        <SidebarAction
          icon="search"
          kbd="⌘K"
          label="搜索"
          onClick={user ? () => setSearchOpen(true) : requireLogin}
        />
        <SidebarAction
          active={pathname === '/tasks'}
          icon="task"
          label="需求单"
          onClick={user ? () => navigate({ to: '/tasks' }) : requireLogin}
        />
        <SidebarAction icon="library" label="资料库" onClick={user ? undefined : requireLogin} />
      </nav>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-2 pt-3">
        {!user && <p className="px-2 pt-1 text-body-sm text-on-surface-variant">登录后查看对话</p>}
        {user && (
          <>
            <SidebarSection count={topology.data?.ungroupedCount ?? 0} title="任务">
              {topology.data?.ungrouped.items.map((conversation) => (
                <ConversationRow
                  key={conversation.id}
                  conversation={conversation}
                  onOpenMembership={() => setMembership({ conversation, open: true })}
                />
              ))}
              {topology.data?.ungrouped.items.length === 0 && <EmptyHint>还没有对话</EmptyHint>}
            </SidebarSection>

            <SidebarSection
              action={{
                icon: 'add',
                label: '新建合集',
                onClick: () => setCollectionForm({ open: true }),
              }}
              count={topology.data?.collections.length ?? 0}
              title="合集"
            >
              {topology.data?.collections.map((collection) => (
                <CollectionGroup
                  key={collection.id}
                  collection={collection}
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
                />
              ))}
              {topology.data?.collections.length === 0 && <EmptyHint>还没有合集</EmptyHint>}
            </SidebarSection>
          </>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-border p-2">
        {user ? (
          <CueUserMenu align="top-start" />
        ) : (
          <button
            aria-label="登录"
            className={cn(SIDEBAR_ROW_CLASS, 'group min-w-0 flex-1 py-1.5')}
            onClick={requireLogin}
            type="button"
          >
            <span className="grid size-7 shrink-0 place-items-center rounded-full border border-border bg-surface-container-lowest text-on-surface-variant">
              <Icon decorative name="user" size="md" />
            </span>
            <span aria-hidden className="min-w-0 flex-1 truncate text-left">
              登录
            </span>
          </button>
        )}
        <IconButton label="设置" name="settings" size="md" />
      </div>

      <ConversationSearchDialog onOpenChange={setSearchOpen} open={searchOpen} />
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
    </aside>
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
      <div className="flex items-center gap-1 pr-1">
        <button
          aria-expanded={open}
          className={cn(SIDEBAR_ROW_CLASS, 'min-w-0 flex-1 py-1 text-body-sm')}
          onClick={() => setOpen((prev) => !prev)}
          type="button"
        >
          <span className="min-w-0 flex-1 truncate text-left text-on-surface-variant">
            {title} ({count})
          </span>
          <Icon
            className="shrink-0 text-on-surface-variant"
            decorative
            name={open ? 'collapse' : 'expand'}
            size="sm"
          />
        </button>
        {action && (
          <IconButton label={action.label} name={action.icon} onClick={action.onClick} size="md" />
        )}
      </div>
      {open && <div className="flex flex-col gap-0.5">{children}</div>}
    </section>
  )
}

function EmptyHint({ children }: { children: string }) {
  return <p className="px-2 py-1 text-body-sm text-on-surface-variant">{children}</p>
}

type CollectionGroupProps = {
  collection: {
    conversationCount: number
    id: string
    name: string
    page: { items: SidebarConversation[] }
  }
  onDelete: () => void
  onOpenMembership: (conversation: SidebarConversation) => void
  onRename: () => void
}

/**
 * 合集行：文件夹图标 + 名字 + 条数，展开后是它内嵌的那几段对话；行尾菜单管改名与删除。
 *
 * 内嵌的对话只有最近几段（服务端截断），条数是全部——所以两者对不上是正常的。
 *
 * @param props - 合集、改名/删除入口与打开归属弹窗的回调。
 * @returns 一个合集分组。
 */
function CollectionGroup({
  collection,
  onDelete,
  onOpenMembership,
  onRename,
}: CollectionGroupProps) {
  const [open, setOpen] = useState(false)
  return (
    <div className="flex flex-col gap-0.5">
      <div className="group flex items-center gap-1 pr-1">
        <button
          // 行内还有一个「操作」钮，名字里带上条数才好把两者分开念、也分得开
          aria-expanded={open}
          aria-label={`${collection.name} (${collection.conversationCount})`}
          className={cn(SIDEBAR_ROW_CLASS, 'min-w-0 flex-1 py-1.5')}
          onClick={() => setOpen((prev) => !prev)}
          type="button"
        >
          <Icon className="shrink-0 text-on-surface-variant" decorative name="folder" size="sm" />
          <span aria-hidden className="min-w-0 flex-1 truncate text-left">
            {collection.name}
          </span>
          <span aria-hidden className="shrink-0 text-caption text-on-surface-variant">
            {collection.conversationCount}
          </span>
        </button>
        <MenuRoot>
          <MenuTrigger asChild>
            <IconButton
              className="opacity-0 transition-opacity duration-(--dur-s) group-hover:opacity-100 data-[state=open]:opacity-100"
              label={`${collection.name} 的操作`}
              name="more"
              size="md"
            />
          </MenuTrigger>
          <MenuSurface align="start">
            <MenuItem onSelect={onRename}>重命名</MenuItem>
            <MenuItem destructive onSelect={onDelete}>
              删除
            </MenuItem>
          </MenuSurface>
        </MenuRoot>
      </div>
      {open && (
        <div className="flex flex-col gap-0.5 pl-4">
          {collection.page.items.map((conversation) => (
            <ConversationRow
              key={conversation.id}
              conversation={conversation}
              onOpenMembership={() => onOpenMembership(conversation)}
            />
          ))}
          {collection.page.items.length === 0 && <EmptyHint>这个合集还是空的</EmptyHint>}
        </div>
      )}
    </div>
  )
}

/**
 * 对话行：截断标题在左，hover 才露出的归属钮在右。
 *
 * @param props - 对话与打开归属弹窗的回调。
 * @returns 单个对话行。
 */
function ConversationRow({
  conversation,
  onOpenMembership,
}: {
  conversation: SidebarConversation
  onOpenMembership: () => void
}) {
  return (
    <div className="group flex items-center gap-1 pr-1">
      <button className={cn(SIDEBAR_ROW_CLASS, 'min-w-0 flex-1 py-1.5')} type="button">
        <span className="min-w-0 flex-1 truncate text-left">{conversation.title}</span>
      </button>
      <IconButton
        className="opacity-0 transition-opacity duration-(--dur-s) group-hover:opacity-100"
        label={`${conversation.title} 的归属`}
        name="folder"
        onClick={onOpenMembership}
        size="md"
      />
    </div>
  )
}

type SidebarActionProps = {
  active?: boolean
  icon: IconName
  /** 右侧快捷键提示，缺省不渲染 */
  kbd?: string
  label: string
  onClick?: (() => void) | undefined
}

/**
 * 侧栏操作行：全宽幽灵按钮，右侧 kbd 提示默认隐藏、hover 行才淡入；
 * 当前页面对应的入口带高亮（active）。
 *
 * @param props - 图标、快捷键提示、文案、高亮态与点击回调。
 * @returns 单个侧栏操作按钮。
 */
function SidebarAction({ active = false, icon, kbd, label, onClick }: SidebarActionProps) {
  return (
    <button
      aria-current={active ? 'page' : undefined}
      aria-label={label}
      className={cn(
        SIDEBAR_ROW_CLASS,
        'group w-full',
        active && 'bg-surface-container font-medium',
      )}
      onClick={onClick}
      type="button"
    >
      <Icon className="text-on-surface" decorative name={icon} size="md" />
      <span aria-hidden className="min-w-0 flex-1 truncate text-left">
        {label}
      </span>
      {kbd && (
        <kbd
          aria-hidden
          className={cn(
            'rounded-xs border border-outline-variant px-1 py-0.5 text-caption text-on-surface-variant',
            'opacity-0 transition-opacity duration-(--dur-s) group-hover:opacity-100',
          )}
        >
          {kbd}
        </kbd>
      )}
    </button>
  )
}
