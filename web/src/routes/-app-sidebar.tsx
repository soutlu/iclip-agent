import { useState } from 'react'
import { ProducerUserMenu } from '@/features/auth'
import { useUser } from '@/shared/auth'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { Button, IconButton } from '@/shared/ui/button'
import { useLoginPrompt } from './-login-prompt'

/**
 * 应用侧栏：每页共享的外壳（品牌区、新建对话 / 搜索入口、会话分区、账户区）。
 *
 * 结构对齐 Kimi Code Web 的侧栏：264 宽、可折叠为 0（折叠后主区左上浮出展开钮）、
 * kbd 快捷键提示只在 hover 行时淡入。当前只做外观——新建 / 搜索 / 会话列表都还没接后端。
 * 未登录时会话区与账户区退成登录入口，点任何操作都弹登录框。
 *
 * @returns 侧栏与折叠态下的浮出展开按钮。
 */
export function AppSidebar() {
  // 紧凑屏（< --breakpoint-sm 600）默认收起，展开后成浮层；桌面默认展开、收入布局流
  const [collapsed, setCollapsed] = useState(() => !window.matchMedia('(min-width: 600px)').matches)
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
        'layer-sidebar flex h-dvh w-(--layout-app-sidebar-width) shrink-0 flex-col border-r border-border bg-background',
        'max-sm:fixed max-sm:top-0 max-sm:left-0 max-sm:shadow-[var(--shadow-2)] sm:sticky sm:top-0',
      )}
    >
      <div className="flex items-center gap-2 px-3 pt-3 pb-1">
        <span className="grid size-(--control-height-md) shrink-0 place-items-center rounded-md bg-primary text-on-primary">
          <Icon decorative name="clip" size="lg" />
        </span>
        <span className="min-w-0 flex-1 truncate text-title font-semibold text-on-surface">
          Producer
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
          label="新建对话"
          onClick={user ? undefined : requireLogin}
        />
        <SidebarAction
          icon="search"
          kbd="⌘K"
          label="搜索"
          onClick={user ? undefined : requireLogin}
        />
      </nav>

      <div className="flex min-h-0 flex-1 flex-col px-2 pt-4">
        <div className="flex items-center justify-between px-2 pb-1">
          <h2 className="text-label font-semibold tracking-wide text-on-surface-variant">会话</h2>
          <div className="flex items-center">
            <IconButton
              label="新建工作区"
              name="folder-plus"
              onClick={user ? undefined : requireLogin}
              size="md"
            />
            <IconButton
              label="切换分组视图"
              name="view-group"
              onClick={user ? undefined : requireLogin}
              size="md"
            />
          </div>
        </div>
        <p className="px-2 pt-1 text-body-sm text-on-surface-variant">
          {user ? '还没有会话 · 点击 新建对话 开始' : '登录后查看会话'}
        </p>
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-border p-2">
        {user ? (
          <ProducerUserMenu align="top-start" />
        ) : (
          <Button className="flex-1" onClick={requireLogin} size="md">
            登录
          </Button>
        )}
        <IconButton label="设置" name="settings" size="md" />
      </div>
    </aside>
  )
}

type SidebarActionProps = {
  icon: 'chat-new' | 'search'
  kbd: string
  label: string
  onClick?: (() => void) | undefined
}

/**
 * 侧栏操作行：全宽幽灵按钮，右侧 kbd 提示默认隐藏、hover 行才淡入。
 *
 * @param props - 图标、快捷键提示、文案与点击回调。
 * @returns 单个侧栏操作按钮。
 */
function SidebarAction({ icon, kbd, label, onClick }: SidebarActionProps) {
  return (
    <button
      aria-label={label}
      className={cn(
        'group flex w-full ui-state cursor-pointer items-center gap-2 rounded-sm px-2 py-2 ui-focus',
        'text-body text-on-surface',
      )}
      onClick={onClick}
      type="button"
    >
      <Icon className="text-on-surface" decorative name={icon} size="md" />
      <span aria-hidden className="min-w-0 flex-1 truncate text-left">
        {label}
      </span>
      <kbd
        aria-hidden
        className={cn(
          'rounded-xs border border-outline-variant px-1 py-0.5 text-caption text-on-surface-variant',
          'opacity-0 transition-opacity duration-(--dur-s) group-hover:opacity-100',
        )}
      >
        {kbd}
      </kbd>
    </button>
  )
}
