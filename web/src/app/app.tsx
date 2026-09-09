import { QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { router } from '@/app/router'
import { workbenchRegistry } from '@/app/workbench-registry'
import { queryClient } from '@/shared/api/query-client'
import { TranscriptProvider } from '@/shared/transcript/transcript-provider'
import { Toaster } from '@/shared/ui/toast'
import { WorkbenchRegistryProvider, WorkbenchSelectionProvider } from '@/shared/workbench'

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TranscriptProvider>
        <WorkbenchRegistryProvider registry={workbenchRegistry}>
          <WorkbenchSelectionProvider>
            <RouterProvider router={router} />
          </WorkbenchSelectionProvider>
        </WorkbenchRegistryProvider>
      </TranscriptProvider>
      <Toaster />
    </QueryClientProvider>
  )
}
