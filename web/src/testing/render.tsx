import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { TranscriptProvider } from '@/shared/transcript/transcript-provider'
import { WorkbenchSelectionProvider } from '@/shared/workbench'
import { FakeSocket, SERVER_HELLO } from './ws'

/**
 * 在真实 Provider 树里渲染被测组件：新建的 QueryClient（不重试，失败立刻可断言）
 * 加一个内存路由，Link / useNavigate 都能工作，跳转结果看 router.state。
 *
 * 路由树只有根路由加一条 `/c/$conversationId`：被测组件一律挂在根上，会话页那条路由不画
 * 任何东西，只让 `initialPath` 给成 `/c/<id>` 时 `useParams` 认得出「打开着哪一段」。
 *
 * 订阅连接与工作台选中态也在树里，与应用壳（`app.tsx`）一致——侧栏、会话页、输入框都会问它们
 * 要东西，缺了就抛。
 * 连接用假 socket，握手帧已经灌好；返回的 `socket` 可以继续往里灌帧。
 */
export const renderWithProviders = async (ui: ReactNode, { initialPath = '/' } = {}) => {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  })
  const socket = new FakeSocket()
  const rootRoute = createRootRoute({ component: () => ui })
  const conversationRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/c/$conversationId',
  })
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: [initialPath] }),
    routeTree: rootRoute.addChildren([conversationRoute]),
  })
  // 先把路由匹配算完再挂载，首帧就是被测组件，不用每个测试都 findBy 等一拍
  await router.load()

  const result = render(
    <QueryClientProvider client={queryClient}>
      <TranscriptProvider createSocket={() => socket as unknown as WebSocket}>
        <WorkbenchSelectionProvider>
          <RouterProvider router={router} />
        </WorkbenchSelectionProvider>
      </TranscriptProvider>
    </QueryClientProvider>,
  )
  socket.deliver(SERVER_HELLO)

  return { ...result, queryClient, router, socket }
}
