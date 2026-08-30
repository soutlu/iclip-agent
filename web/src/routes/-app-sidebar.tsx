import { useNavigate, useRouterState } from '@tanstack/react-router'
import { useState } from 'react'
import { CueUserMenu } from '@/features/auth'
import { useUser } from '@/shared/auth'
import { Icon, type IconName } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/button'
import { useLoginPrompt } from './-login-prompt'

type SessionTab = 'running' | 'done' | 'workspace'

// 侧栏里三种行（操作行、会话行、未登录的登录行）共用的外观：幽灵行，
// hover / pressed 由 ui-state 铺，焦点走 ui-focus。宽度与内距由调用处按需覆盖。
const SIDEBAR_ROW_CLASS =
  'flex ui-state cursor-pointer items-center gap-2 rounded-sm px-2 py-2 ui-focus text-body text-on-surface'

// 会话列表还没接后端，这里用演示数据呈现行尾状态标识
// （进行中 primary 转圈 / 待回答 warning 徽章 / 已完成 status-success 对勾 / 失败 status-error 红叉）
const DEMO_SESSIONS: Record<
  Exclude<SessionTab, 'workspace'>,
  { title: string; status: 'running' | 'waiting' | 'done' | 'failed' }[]
> = {
  running: [
    { title: '产品宣传片 · 分镜生成中', status: 'running' },
    { title: '当前项目用于复刻 kimi code 的 web 端', status: 'waiting' },
  ],
  done: [
    { title: '夏季亚麻系列广告', status: 'done' },
    { title: '通勤背包短视频', status: 'done' },
    { title: '夜景延时素材生成', status: 'failed' },
  ],
}

/**
 * 应用侧栏：每页共享的外壳（品牌区、新建任务 / 搜索 / 任务 / 资料库入口、会话分段与列表、账户区）。
 *
 * 结构对齐 Kimi Code Web 的侧栏：264 宽、可折叠为 0（折叠后主区左上浮出展开钮）、
 * kbd 快捷键提示只在 hover 行时淡入；会话区用分段 tab（进行中 / 已完成 / 工作空间），
 * 进行中的 tab 带 primary 圆点，会话行尾带状态标识。新建任务回首页起新一轮对话，
 * 搜索与会话列表还没接后端。未登录时会话区与账户区退成登录入口，点任何操作都弹登录框。
 *
 * @returns 侧栏与折叠态下的浮出展开按钮。
 */
export function AppSidebar() {
  // 紧凑屏（< --breakpoint-sm 600）默认收起，展开后成浮层；桌面默认展开、收入布局流
  const [collapsed, setCollapsed] = useState(() => !window.matchMedia('(min-width: 600px)').matches)
  const navigate = useNavigate()
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const [tab, setTab] = useState<SessionTab>('running')
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
          onClick={user ? undefined : requireLogin}
        />
        <SidebarAction
          active={pathname === '/tasks'}
          icon="task"
          label="任务"
          onClick={user ? () => navigate({ to: '/tasks' }) : requireLogin}
        />
        <SidebarAction icon="library" label="资料库" onClick={user ? undefined : requireLogin} />
      </nav>

      <div className="flex min-h-0 flex-1 flex-col px-2 pt-3">
        <div
          aria-label="会话筛选"
          className="flex rounded-full bg-surface-container p-0.5"
          role="tablist"
        >
          <SidebarTab active={tab === 'running'} dot onClick={() => setTab('running')}>
            进行中
          </SidebarTab>
          <SidebarTab active={tab === 'done'} onClick={() => setTab('done')}>
            已完成
          </SidebarTab>
          <SidebarTab active={tab === 'workspace'} onClick={() => setTab('workspace')}>
            工作空间
          </SidebarTab>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto pt-1">
          {!user && (
            <p className="px-2 pt-1 text-body-sm text-on-surface-variant">登录后查看会话</p>
          )}
          {user && tab === 'workspace' && (
            <p className="px-2 pt-1 text-body-sm text-on-surface-variant">还没有工作区</p>
          )}
          {user &&
            tab !== 'workspace' &&
            DEMO_SESSIONS[tab].map((session) => (
              <SessionRow key={session.title} status={session.status} title={session.title} />
            ))}
        </div>
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
    </aside>
  )
}

type SidebarTabProps = {
  active: boolean
  children: string
  /** 进行中的 tab 带一颗 primary 圆点，提示有活着的任务 */
  dot?: boolean
  onClick: () => void
}

/**
 * 会话分段 tab：灰胶囊容器里的等宽项，选中项抬成 top-layer 白丸并带轻影。
 *
 * @param props - 选中态、文案、圆点与点击回调。
 * @returns 单个分段 tab。
 */
function SidebarTab({ active, children, dot, onClick }: SidebarTabProps) {
  return (
    <button
      aria-selected={active}
      className={cn(
        'flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-full py-1.5 ui-focus ui-motion-s',
        'text-body-sm transition-[background-color,color,box-shadow]',
        active
          ? 'bg-top-layer font-medium text-on-surface shadow-[var(--shadow-1)]'
          : 'text-on-surface-variant hover:text-on-surface',
      )}
      onClick={onClick}
      role="tab"
      type="button"
    >
      {dot ? <span aria-hidden className="size-1.5 rounded-full bg-primary" /> : null}
      {children}
    </button>
  )
}

type SessionRowProps = {
  status: 'running' | 'waiting' | 'done' | 'failed'
  title: string
}

/**
 * 会话行：截断标题在左，状态标识在右，取设计系统状态色——进行中 primary 转圈、
 * 待回答 warning（琥珀）描边徽章、已完成 chat-status-success 对勾、
 * 失败 chat-status-error 红叉（对齐 kimi 的行尾状态位）。
 *
 * @param props - 会话状态与标题。
 * @returns 单个会话行按钮。
 */
function SessionRow({ status, title }: SessionRowProps) {
  return (
    <button className={cn(SIDEBAR_ROW_CLASS, 'w-full')} type="button">
      <span className="min-w-0 flex-1 truncate text-left">{title}</span>
      {status === 'running' && (
        <Icon className="shrink-0 animate-spin text-primary" decorative name="loading" size="sm" />
      )}
      {status === 'waiting' && (
        <span className="shrink-0 rounded-full border border-warning px-1.5 py-0.5 text-caption text-warning">
          待回答
        </span>
      )}
      {status === 'done' && (
        <Icon className="shrink-0 text-chat-status-success" decorative name="success" size="sm" />
      )}
      {status === 'failed' && (
        <Icon className="shrink-0 text-chat-status-error" decorative name="failed" size="sm" />
      )}
    </button>
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
