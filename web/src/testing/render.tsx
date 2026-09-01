import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { TranscriptProvider } from '@/shared/transcript/transcript-provider'
import { FakeSocket, SERVER_HELLO } from './ws'

/**
 * 在真实 Provider 树里渲染被测组件：新建的 QueryClient（不重试，失败立刻可断言）
 * 加一个只有根路由的内存路由，Link / useNavigate 都能工作，跳转结果看 router.state。
 *
 * 订阅连接也在树里，与应用壳（`app.tsx`）一致——侧栏与会话页都会问它要东西，缺了就抛。
 * 连接用假 socket，握手帧已经灌好；返回的 `socket` 可以继续往里灌帧。
 */
export const renderWithProviders = async (ui: ReactNode, { initialPath = '/' } = {}) => {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  })
  const socket = new FakeSocket()
  const rootRoute = createRootRoute({ component: () => ui })
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: [initialPath] }),
    routeTree: rootRoute,
  })
  // 先把路由匹配算完再挂载，首帧就是被测组件，不用每个测试都 findBy 等一拍
  await router.load()

  const result = render(
    <QueryClientProvider client={queryClient}>
      <TranscriptProvider createSocket={() => socket as unknown as WebSocket}>
        <RouterProvider router={router} />
      </TranscriptProvider>
    </QueryClientProvider>,
  )
  socket.deliver(SERVER_HELLO)

  return { ...result, queryClient, router, socket }
}
