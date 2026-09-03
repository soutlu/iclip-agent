import { QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { router } from '@/app/router'
import { workbenchRegistry } from '@/app/workbench-registry'
import { queryClient } from '@/shared/api/query-client'
import { TranscriptProvider } from '@/shared/transcript/transcript-provider'
import { Toaster } from '@/shared/ui/toast'
import { WorkbenchRegistryProvider } from '@/shared/workbench'

/**
 * 渲染应用根组件：挂载 TanStack Query、对话订阅连接、产物类型注册表、路由与全局 toast 出口。
 *
 * @returns 应用根组件。
 */
export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TranscriptProvider>
        <WorkbenchRegistryProvider registry={workbenchRegistry}>
          <RouterProvider router={router} />
        </WorkbenchRegistryProvider>
      </TranscriptProvider>
      <Toaster />
    </QueryClientProvider>
  )
}
