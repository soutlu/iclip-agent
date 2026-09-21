import { createFileRoute } from '@tanstack/react-router'
import { ConversationsRoute, useAuditConversations } from '@/features/conversations'
import { rememberReturn } from '../-conversations-return'
import {
  conversationsSearchSchema,
  filtersFromSearch,
  searchFromFilters,
} from '../-conversations-search'
import { requireGovernor } from '../-require-governor'
import { useAuditTaskPreviews } from '../-use-audit-task-previews'
import { useTaskPickerSource } from '../-use-task-picker-source'

// 筛选条件存在查询参数里，浏览器后退、刷新与分享链接都还原同一屏。
export const Route = createFileRoute('/_shell/conversations')({
  beforeLoad: requireGovernor,
  component: ConversationsPage,
  validateSearch: conversationsSearchSchema,
})

function ConversationsPage() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const tasks = useTaskPickerSource()
  const filters = filtersFromSearch(search)
  const conversations = useAuditConversations(filters, true)
  const taskIds = (conversations.data?.pages.flatMap((page) => page.items) ?? []).flatMap((row) =>
    row.taskId ? [row.taskId] : [],
  )
  const { taskPreviews, taskPreviewState, taskPreviewRetry } = useAuditTaskPreviews(taskIds)

  return (
    <ConversationsRoute
      filters={filters}
      // 改筛选是换视图不是换页面，替换当前历史记录，免得后退键要按很多次才出得去。
      onFiltersChange={(next) => void navigate({ replace: true, search: searchFromFilters(next) })}
      // 对话页的返回按钮是一次新跳转而非后退，拿不到历史里的地址，进哪段对话时就把这一屏留下。
      onOpen={(conversationId) => rememberReturn(conversationId, search)}
      tasks={tasks}
      taskPreviews={taskPreviews}
      taskPreviewState={taskPreviewState}
      taskPreviewRetry={taskPreviewRetry}
    />
  )
}
