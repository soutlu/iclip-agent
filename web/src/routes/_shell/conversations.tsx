import { createFileRoute } from '@tanstack/react-router'
import { ConversationsRoute } from '@/features/conversations'
import { rememberReturn } from '../-conversations-return'
import {
  conversationsSearchSchema,
  filtersFromSearch,
  searchFromFilters,
} from '../-conversations-search'
import { requireGovernor } from '../-require-governor'
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

  return (
    <ConversationsRoute
      filters={filtersFromSearch(search)}
      // 改筛选是换视图不是换页面，替换当前历史记录，免得后退键要按很多次才出得去。
      onFiltersChange={(next) => void navigate({ replace: true, search: searchFromFilters(next) })}
      // 对话页的返回按钮是一次新跳转而非后退，拿不到历史里的地址，进哪段对话时就把这一屏留下。
      onOpen={(conversationId) => rememberReturn(conversationId, search)}
      tasks={tasks}
    />
  )
}
