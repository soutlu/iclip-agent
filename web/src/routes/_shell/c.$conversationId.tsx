import { createFileRoute, redirect, useParams } from '@tanstack/react-router'
import { z } from 'zod'
import { ConversationRoute } from '@/features/conversations'
import { ensureSessionUser } from '@/shared/auth'
import { WorkbenchHost } from '@/shared/workbench'

// 产物面板的状态放查询串：刷新、分享链接都能回到同一件产物的同一组同一帧（ADR-0009 决策 6）。
const ConversationSearchSchema = z.object({
  artifact: z.string().optional().catch(undefined),
  frame: z.int().positive().optional().catch(undefined),
  sheet: z.enum(['all', 'records']).optional().catch(undefined),
  shot: z.int().positive().optional().catch(undefined),
  take: z.string().optional().catch(undefined),
})

// 会话页只对登录用户开放：对话是私有的，未登录（含会话过期后 401 触发的路由重算）回首页。
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

/**
 * 装配会话页。
 *
 * @returns 会话页内容。
 */
function ConversationIndexRoute() {
  const { conversationId } = Route.useParams()
  return <ConversationRoute key={conversationId} conversationId={conversationId} />
}

/**
 * 装配会话页的右面板内容。
 *
 * 面板由壳渲染，不在本路由的组件树里，所以对话 id 从当前匹配上取。
 *
 * @returns 产物面板。
 */
function ConversationWorkbenchPanel() {
  const { conversationId } = useParams({ strict: false })
  if (conversationId === undefined) return null
  return <WorkbenchHost conversationId={conversationId} key={conversationId} />
}
