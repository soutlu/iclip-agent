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

// 数值与 design-system.html 的 --layout-app-* 对齐；可拖宽度需在 JS 中计算并排空间。
const SIDEBAR_DEFAULT = 264
const SIDEBAR_MIN = 200
const SIDEBAR_MAX = 400
const WORKBENCH_DEFAULT = 820
const WORKBENCH_MIN = 560
const CHAT_MIN = 400
const COMPACT_MAX = 600

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

// SSO 失败通过 ssoError 查询参数触发登录弹窗。
const ShellSearchSchema = z.object({
  ssoError: z.string().optional().catch(undefined),
})

export const Route = createFileRoute('/_shell')({
  component: AppShell,
  validateSearch: ShellSearchSchema,
})

/** 应用壳统一持有三列宽度，通过 CSS 变量下发，避免侧栏与面板各自持久化。 */
function AppShell() {
  const navigate = useNavigate()
  const { ssoError } = Route.useSearch()
  const [loginOpen, setLoginOpen] = useState(Boolean(ssoError))

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

  // 用 ref 保存拖动起点和最新宽度，避免结束回调闭包读取拖动前的 state。
  const dragOriginRef = useRef(0)
  const dragValueRef = useRef(0)

  const sidebarWidth = clamp(sidebar.width, SIDEBAR_MIN, SIDEBAR_MAX)
  const occupiedBySidebar = sidebarCollapsed ? 0 : sidebarWidth
  const sideBySide = viewport >= occupiedBySidebar + CHAT_MIN + WORKBENCH_MIN
  const compact = viewport < COMPACT_MAX
  // 根据视口和侧栏限制面板宽度，保证聊天区最小宽度。
  const workbenchWidth = clamp(
    workbench.width,
    WORKBENCH_MIN,
    Math.max(WORKBENCH_MIN, viewport - occupiedBySidebar - CHAT_MIN),
  )

  const handleLoginOpenChange = useCallback(
    (open: boolean) => {
      setLoginOpen(open)

      // 消费后移除错误码，避免刷新重复弹窗。
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

        {/* 紧凑屏侧栏不占布局空间，不显示拖柄。 */}
        {sidebarCollapsed || compact ? null : (
          <AppResizeHandle
            label="调整侧栏宽度"
            max={SIDEBAR_MAX}
            min={SIDEBAR_MIN}
            onReset={() => {
              sidebar.setWidth(SIDEBAR_DEFAULT)
              sidebar.persist(SIDEBAR_DEFAULT)
            }}
            onResize={(delta) => {
              dragValueRef.current = clamp(dragOriginRef.current + delta, SIDEBAR_MIN, SIDEBAR_MAX)
              sidebar.setWidth(dragValueRef.current)
            }}
            onResizeEnd={() => sidebar.persist(dragValueRef.current)}
            onResizeStart={() => {
              dragOriginRef.current = sidebarWidth
              dragValueRef.current = sidebarWidth
            }}
            value={sidebarWidth}
          />
        )}

        {/* 主区为覆盖模式的右面板提供定位上下文。 */}
        <div className="relative flex min-w-0 flex-1">
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
              // 面板左侧拖柄向右移动时宽度减小，位移取反。
              onResize={(delta) => {
                dragValueRef.current = clamp(
                  dragOriginRef.current - delta,
                  WORKBENCH_MIN,
                  Math.max(WORKBENCH_MIN, viewport - occupiedBySidebar - CHAT_MIN),
                )
                workbench.setWidth(dragValueRef.current)
              }}
              onResizeEnd={() => workbench.persist(dragValueRef.current)}
              onResizeStart={() => {
                dragOriginRef.current = workbenchWidth
                dragValueRef.current = workbenchWidth
              }}
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
