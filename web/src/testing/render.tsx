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

/** 使用独立 QueryClient、内存路由、订阅连接和工作台 Provider；/c/$conversationId 仅供参数匹配，socket 已完成握手。 */
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
  // 先完成路由加载，使首帧即可渲染被测组件。
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
