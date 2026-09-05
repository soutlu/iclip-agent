import { createFileRoute, redirect, useParams } from '@tanstack/react-router'
import { z } from 'zod'
import { ConversationRoute } from '@/features/conversations'
import { ensureSessionUser } from '@/shared/auth'
import { WorkbenchHost } from '@/shared/workbench'

// 产物、组和帧状态保存在查询参数，支持刷新与分享（ADR-0009 决策 6）。
const ConversationSearchSchema = z.object({
  artifact: z.string().optional().catch(undefined),
  frame: z.int().positive().optional().catch(undefined),
  sheet: z.enum(['all', 'records']).optional().catch(undefined),
  shot: z.int().positive().optional().catch(undefined),
  take: z.string().optional().catch(undefined),
})

// 会话为私有内容，未登录或会话失效时由路由守卫返回首页。
export const Route = createFileRoute('/_shell/c/$conversationId')({
  beforeLoad: async () => {
    if (!(await ensureSessionUser())) {
      throw redirect({ to: '/' })
    }
  },
  component: ConversationIndexRoute,
  staticData: { rightPanel: ConversationWorkbenchPanel },
  validateSearch: ConversationSearchSchema,
})

function ConversationIndexRoute() {
  const { conversationId } = Route.useParams()
  return <ConversationRoute key={conversationId} conversationId={conversationId} />
}

/** 面板由壳渲染，对话 ID 需从当前匹配路由读取。 */
function ConversationWorkbenchPanel() {
  const { conversationId } = useParams({ strict: false })
  if (conversationId === undefined) return null
  return <WorkbenchHost conversationId={conversationId} key={conversationId} />
}
