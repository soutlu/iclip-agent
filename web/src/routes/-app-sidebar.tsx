import { useNavigate, useRouterState } from '@tanstack/react-router'
import { useState } from 'react'
import { CueUserMenu } from '@/features/auth'
import { ConversationSearchDialog } from '@/features/conversations'
import { useUser } from '@/shared/auth'
import { Icon, type IconName } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/button'
import { useLoginPrompt } from './-login-prompt'
import { SidebarConversations } from './-sidebar-conversations'

// 侧栏里几种行（操作行、对话行、合集行、未登录的登录行）共用的外观：幽灵行，
// hover / pressed 由 ui-state 铺，焦点走 ui-focus。宽度与内距由调用处按需覆盖。
const SIDEBAR_ROW_CLASS =
  'flex ui-state cursor-pointer items-center gap-2 rounded-sm px-3 py-2 ui-focus text-body text-on-surface'

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
        'layer-sidebar flex h-dvh w-(--layout-app-sidebar-width) shrink-0 flex-col border-r border-border bg-surface-container',
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

      <nav aria-label="会话操作" className="flex flex-col gap-0.5 px-3 pt-2">
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

      {/* 未登录也要把中间撑满，否则底部账户区会顶到导航底下 */}
      {user ? (
        <SidebarConversations />
      ) : (
        <div className="min-h-0 flex-1 px-3 pt-4">
          <p className="text-body-sm text-on-surface-muted">登录后查看对话</p>
        </div>
      )}

      <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2">
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
    </aside>
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
