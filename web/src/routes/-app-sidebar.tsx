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

// 侧栏行共用 ui-state 与 ui-focus，尺寸由调用方控制。
const SIDEBAR_ROW_CLASS =
  'flex ui-state cursor-pointer items-center gap-2 rounded-sm px-3 py-2 ui-focus text-body text-on-surface'

type AppSidebarProps = {
  collapsed: boolean
  onCollapsedChange: (collapsed: boolean) => void
}

/** 折叠状态由应用壳持有，供拖柄与聊天、面板并排布局统一计算。 */
export function AppSidebar({ collapsed, onCollapsedChange }: AppSidebarProps) {
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
        onClick={() => onCollapsedChange(false)}
        size="md"
      />
    )
  }

  return (
    <aside
      className={cn(
        'layer-sidebar flex h-dvh w-(--layout-app-sidebar-width) shrink-0 flex-col border-r-[0.5px] border-border bg-background',
        'max-sm:fixed max-sm:top-0 max-sm:left-0 max-sm:shadow-[var(--shadow-2)] sm:sticky sm:top-0',
      )}
    >
      <div className="flex items-center gap-2 px-3 pt-3 pb-1">
        <span
          aria-hidden
          className="grid size-(--control-height-md) shrink-0 place-items-center rounded-sm bg-primary font-home-display text-title font-semibold text-on-primary italic"
        >
          C
        </span>
        <span className="min-w-0 flex-1 truncate font-home-display text-title-lg font-semibold tracking-[-0.02em] text-on-surface italic">
          Cue
        </span>
        <IconButton
          label="折叠侧边栏"
          name="panel-left"
          onClick={() => onCollapsedChange(true)}
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

      {/* 未登录时保留弹性空间，使账户区保持底部对齐。 */}
      {user ? (
        <SidebarConversations />
      ) : (
        <div className="min-h-0 flex-1 px-3 pt-4">
          <p className="text-body-sm text-on-surface-faint">登录后查看对话</p>
        </div>
      )}

      <div className="flex items-center justify-between gap-2 border-t-[0.5px] border-border px-3 py-2">
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
  kbd?: string
  label: string
  onClick?: (() => void) | undefined
}

function SidebarAction({ active = false, icon, kbd, label, onClick }: SidebarActionProps) {
  return (
    <button
      aria-current={active ? 'page' : undefined}
      aria-label={label}
      className={cn(SIDEBAR_ROW_CLASS, 'group w-full', active && 'bg-state-active font-medium')}
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
            'rounded-xs border border-border px-1 py-0.5 text-caption text-on-surface-faint',
            'opacity-0 transition-opacity duration-(--dur-s) group-hover:opacity-100',
          )}
        >
          {kbd}
        </kbd>
      )}
    </button>
  )
}
