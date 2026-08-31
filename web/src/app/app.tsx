import { QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { router } from '@/app/router'
import { queryClient } from '@/shared/api/query-client'
import { TranscriptProvider } from '@/shared/transcript/transcript-provider'
import { Toaster } from '@/shared/ui/toast'

/**
 * 渲染应用根组件：挂载 TanStack Query、对话订阅连接、路由与全局 toast 出口。
 *
 * @returns 应用根组件。
 */
export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TranscriptProvider>
        <RouterProvider router={router} />
      </TranscriptProvider>
      <Toaster />
    </QueryClientProvider>
  )
}
