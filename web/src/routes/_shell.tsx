import { createFileRoute, Outlet, useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { z } from 'zod'
import { LoginDialog } from '@/features/auth'
import { cn } from '@/shared/lib/utils'
import { WorkbenchLayoutProvider } from '@/shared/workbench'
import { AppResizeHandle } from './-app-resize-handle'
import { AppRightPanel } from './-app-right-panel'
import { AppSidebar } from './-app-sidebar'
import { LoginPromptProvider } from './-login-prompt'
import { useStoredWidth } from './-use-stored-width'

// 这几个数与 design-system.html 的 --layout-app-* 同值：媒体查询取不到 CSS 变量，
// 而「放不放得下并排」要在 JS 里算（侧栏宽度可拖，不是一个断点能定的）。
const SIDEBAR_DEFAULT = 264
const SIDEBAR_MIN = 200
const SIDEBAR_MAX = 400
const WORKBENCH_DEFAULT = 820
const WORKBENCH_MIN = 560
const CHAT_MIN = 400
const COMPACT_MAX = 600

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

// SSO 落地页换会话失败时带 ?ssoError= 回到这里，壳读到就把登录弹窗打开。
const ShellSearchSchema = z.object({
  ssoError: z.string().optional().catch(undefined),
})

// 应用壳：不要求登录。未登录也能进，动到需要登录的功能时才弹登录框。
export const Route = createFileRoute('/_shell')({
  component: AppShell,
  validateSearch: ShellSearchSchema,
})

/**
 * 渲染应用壳：侧栏、内容出口、右面板、两道拖柄与登录弹窗。
 *
 * 侧栏放这里而不是放进某个 feature——它每页都要有，塞进 feature 就会逼出跨 feature
 * 依赖，而跨 feature 是禁止的。右面板与登录弹窗同理：页面只通过 useLoginPrompt 请求登录。
 *
 * 三列的宽度也归壳：拖柄改的是这里的状态，经 CSS 变量下发，侧栏与面板各自只管按变量取宽，
 * 不各自读一份 localStorage。
 *
 * @returns 带侧栏、右面板与登录弹窗的路由出口。
 */
function AppShell() {
  const navigate = useNavigate()
  const { ssoError } = Route.useSearch()
  // SSO 失败带回来的错误码要自己把弹窗打开，其余情况由页面动作触发
  const [loginOpen, setLoginOpen] = useState(Boolean(ssoError))

  // 紧凑屏（< --breakpoint-sm 600）默认收起，展开后成浮层；桌面默认展开、收入布局流
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => !window.matchMedia(`(min-width: ${COMPACT_MAX}px)`).matches,
  )
  const [panelVisible, setPanelVisible] = useState(false)
  const sidebar = useStoredWidth('sidebar-width', SIDEBAR_DEFAULT)
  const workbench = useStoredWidth('workbench-width', WORKBENCH_DEFAULT)
  const [viewport, setViewport] = useState(() => window.innerWidth)

  useEffect(() => {
    const sync = () => setViewport(window.innerWidth)
    window.addEventListener('resize', sync)
    return () => window.removeEventListener('resize', sync)
  }, [])

  // 拖动期间的基准宽：拖柄只报位移，起点得由这边记。
  const dragOriginRef = useRef(0)

  const sidebarWidth = clamp(sidebar.width, SIDEBAR_MIN, SIDEBAR_MAX)
  const occupiedBySidebar = sidebarCollapsed ? 0 : sidebarWidth
  const sideBySide = viewport >= occupiedBySidebar + CHAT_MIN + WORKBENCH_MIN
  const compact = viewport < COMPACT_MAX
  // 面板再宽也要给聊天留下最小宽，所以上界跟着视口与侧栏走。
  const workbenchWidth = clamp(
    workbench.width,
    WORKBENCH_MIN,
    Math.max(WORKBENCH_MIN, viewport - occupiedBySidebar - CHAT_MIN),
  )

  const handleLoginOpenChange = useCallback(
    (open: boolean) => {
      setLoginOpen(open)

      // 错误码只报一次，留在地址里会导致每次刷新都重新弹窗
      if (!open && ssoError) {
        void navigate({ replace: true, search: {}, to: '.' })
      }
    },
    [navigate, ssoError],
  )

  const requireLogin = useCallback(() => {
    setLoginOpen(true)
  }, [])

  const layout = { compact, onPanelVisible: setPanelVisible, sideBySide }

  const shellVars = {
    '--layout-app-sidebar-width': `${sidebarWidth}px`,
    '--layout-app-workbench-width': `${workbenchWidth}px`,
  } as CSSProperties

  return (
    <LoginPromptProvider value={requireLogin}>
      <div className="flex h-dvh" style={shellVars}>
        <AppSidebar collapsed={sidebarCollapsed} onCollapsedChange={setSidebarCollapsed} />

        {sidebarCollapsed ? null : (
          <AppResizeHandle
            label="调整侧栏宽度"
            max={SIDEBAR_MAX}
            min={SIDEBAR_MIN}
            onReset={() => {
              sidebar.setWidth(SIDEBAR_DEFAULT)
              sidebar.persist(SIDEBAR_DEFAULT)
            }}
            onResize={(delta) =>
              sidebar.setWidth(clamp(dragOriginRef.current + delta, SIDEBAR_MIN, SIDEBAR_MAX))
            }
            onResizeEnd={() => sidebar.persist(sidebar.width)}
            onResizeStart={() => (dragOriginRef.current = sidebarWidth)}
            value={sidebarWidth}
          />
        )}

        {/* 侧栏之外这一块是「主区」：右面板放大或放不下并排时会整块盖住它，所以要有定位上下文 */}
        <div className="relative flex min-w-0 flex-1">
          {/* 主区不自带底色：透出 body 的页面底色（见 base.css html,body） */}
          <div
            className={cn(
              'flex min-w-0 flex-1 flex-col',
              sideBySide && 'min-w-(--layout-app-chat-min-width)',
            )}
          >
            <Outlet />
          </div>

          {sideBySide && panelVisible ? (
            <AppResizeHandle
              label="调整面板宽度"
              max={Math.max(WORKBENCH_MIN, viewport - occupiedBySidebar - CHAT_MIN)}
              min={WORKBENCH_MIN}
              onReset={() => {
                workbench.setWidth(WORKBENCH_DEFAULT)
                workbench.persist(WORKBENCH_DEFAULT)
              }}
              // 拖柄在面板左边：往右拖是把面板压窄，所以位移取反。
              onResize={(delta) => workbench.setWidth(dragOriginRef.current - delta)}
              onResizeEnd={() => workbench.persist(workbenchWidth)}
              onResizeStart={() => (dragOriginRef.current = workbenchWidth)}
              value={workbenchWidth}
            />
          ) : null}

          <WorkbenchLayoutProvider layout={layout}>
            <AppRightPanel />
          </WorkbenchLayoutProvider>
        </div>
      </div>

      <LoginDialog open={loginOpen} onOpenChange={handleLoginOpenChange} ssoErrorCode={ssoError} />
    </LoginPromptProvider>
  )
}
