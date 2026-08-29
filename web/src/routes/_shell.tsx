import { createFileRoute, Outlet, useNavigate } from '@tanstack/react-router'
import { useCallback, useState } from 'react'
import { z } from 'zod'
import { LoginDialog } from '@/features/auth'
import { AppRightPanel } from './-app-right-panel'
import { AppSidebar } from './-app-sidebar'
import { LoginPromptProvider } from './-login-prompt'

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
 * 渲染应用壳：侧栏、内容出口、右面板与登录弹窗。
 *
 * 侧栏放这里而不是放进某个 feature——它每页都要有，塞进 feature 就会逼出跨 feature
 * 依赖，而跨 feature 是禁止的。右面板与登录弹窗同理：页面只通过 useLoginPrompt 请求登录。
 *
 * @returns 带侧栏、右面板与登录弹窗的路由出口。
 */
function AppShell() {
  const navigate = useNavigate()
  const { ssoError } = Route.useSearch()
  // SSO 失败带回来的错误码要自己把弹窗打开，其余情况由页面动作触发
  const [loginOpen, setLoginOpen] = useState(Boolean(ssoError))

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

  return (
    <LoginPromptProvider value={requireLogin}>
      <div className="flex min-h-dvh">
        <AppSidebar />
        {/* 主区不自带底色：透出 body 的页面底色（见 base.css html,body） */}
        <div className="flex min-w-0 flex-1 flex-col">
          <Outlet />
        </div>
        <AppRightPanel />
      </div>

      <LoginDialog open={loginOpen} onOpenChange={handleLoginOpenChange} ssoErrorCode={ssoError} />
    </LoginPromptProvider>
  )
}
