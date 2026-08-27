import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { render } from '@testing-library/react'
import type { ReactNode } from 'react'

/**
 * 在真实 Provider 树里渲染被测组件：新建的 QueryClient（不重试，失败立刻可断言）
 * 加一个只有根路由的内存路由，Link / useNavigate 都能工作，跳转结果看 router.state。
 */
export const renderWithProviders = async (ui: ReactNode, { initialPath = '/' } = {}) => {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  })
  const rootRoute = createRootRoute({ component: () => ui })
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: [initialPath] }),
    routeTree: rootRoute,
  })
  // 先把路由匹配算完再挂载，首帧就是被测组件，不用每个测试都 findBy 等一拍
  await router.load()

  const result = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )

  return { ...result, queryClient, router }
}
