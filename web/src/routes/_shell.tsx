import { createFileRoute, Outlet, useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { z } from 'zod'
import { LoginDialog } from '@/features/auth'
import { cn } from '@/shared/lib/utils'
import { ShellChromeContext } from '@/shared/shell'
import { WorkbenchLayoutProvider } from '@/shared/workbench'
import { AppResizeHandle } from './-app-resize-handle'
import { AppRightPanel } from './-app-right-panel'
import {
  clampWidth,
  COMPACT_MAX,
  resolveShellLayout,
  SIDEBAR_WIDTH,
  WORKBENCH_WIDTH,
} from './-app-shell-layout'
import { AppSidebar } from './-app-sidebar'
import { LoginPromptProvider } from './-login-prompt'
import { useStoredWidth } from './-use-stored-width'

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
  const sidebar = useStoredWidth('sidebar-width', SIDEBAR_WIDTH.default)
  const workbench = useStoredWidth('workbench-width', WORKBENCH_WIDTH.default)
  const [viewport, setViewport] = useState(() => window.innerWidth)

  useEffect(() => {
    const sync = () => setViewport(window.innerWidth)
    window.addEventListener('resize', sync)
    return () => window.removeEventListener('resize', sync)
  }, [])

  // 用 ref 保存拖动起点和最新宽度，避免结束回调闭包读取拖动前的 state。
  const dragOriginRef = useRef(0)
  const dragValueRef = useRef(0)

  const { sidebarWidth, compact, sideBySide, workbenchMax, workbenchWidth } = resolveShellLayout({
    viewport,
    sidebarCollapsed,
    sidebarWidth: sidebar.width,
    workbenchWidth: workbench.width,
  })

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
  // 页头按这两个状态给收起态的展开钮留位；钮本身由侧栏与面板各自画在角上。
  const chrome = useMemo(
    () => ({ panelVisible, sidebarCollapsed }),
    [panelVisible, sidebarCollapsed],
  )

  const shellVars = {
    '--layout-app-sidebar-width': `${sidebarWidth}px`,
    '--layout-app-workbench-width': `${workbenchWidth}px`,
  } as CSSProperties

  return (
    <LoginPromptProvider value={requireLogin}>
      <ShellChromeContext value={chrome}>
        <div className="flex h-dvh" style={shellVars}>
          <AppSidebar collapsed={sidebarCollapsed} onCollapsedChange={setSidebarCollapsed} />

          {/* 紧凑屏侧栏不占布局空间，不显示拖柄。 */}
          {sidebarCollapsed || compact ? null : (
            <AppResizeHandle
              label="调整侧栏宽度"
              max={SIDEBAR_WIDTH.max}
              min={SIDEBAR_WIDTH.min}
              onReset={() => {
                sidebar.setWidth(SIDEBAR_WIDTH.default)
                sidebar.persist(SIDEBAR_WIDTH.default)
              }}
              onResize={(delta) => {
                dragValueRef.current = clampWidth(
                  dragOriginRef.current + delta,
                  SIDEBAR_WIDTH.min,
                  SIDEBAR_WIDTH.max,
                )
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
                max={workbenchMax}
                min={WORKBENCH_WIDTH.min}
                onReset={() => {
                  workbench.setWidth(WORKBENCH_WIDTH.default)
                  workbench.persist(WORKBENCH_WIDTH.default)
                }}
                // 面板左侧拖柄向右移动时宽度减小，位移取反。
                onResize={(delta) => {
                  dragValueRef.current = clampWidth(
                    dragOriginRef.current - delta,
                    WORKBENCH_WIDTH.min,
                    workbenchMax,
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
      </ShellChromeContext>

      <LoginDialog open={loginOpen} onOpenChange={handleLoginOpenChange} ssoErrorCode={ssoError} />
    </LoginPromptProvider>
  )
}
