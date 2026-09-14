import { createFileRoute, redirect, useParams } from '@tanstack/react-router'
import { z } from 'zod'
import { ConversationRoute } from '@/features/conversations'
import { shotContentIdSchema } from '@/features/storyboard'
import { ensureSessionUser } from '@/shared/auth'
import { canonicalUuid } from '@/shared/lib/uuid'
import { WorkbenchHost } from '@/shared/workbench'

// 产物、组、帧与正在看的文件保存在查询参数，支持刷新与分享（ADR-0009 决策 6）。
const ConversationSearchSchema = z.object({
  artifact: z.string().optional().catch(undefined),
  file: z.string().optional().catch(undefined),
  content: shotContentIdSchema.optional().catch(undefined),
  frame: z.int().positive().optional().catch(undefined),
  sheet: z.enum(['all', 'prompt', 'records']).optional().catch(undefined),
  shot: z.int().positive().optional().catch(undefined),
  take: z.string().optional().catch(undefined),
})

// 会话为私有内容，未登录或会话失效时由路由守卫返回首页。
export const Route = createFileRoute('/_shell/c/$conversationId')({
  beforeLoad: async ({ params, search }) => {
    if (!(await ensureSessionUser())) {
      throw redirect({ to: '/' })
    }
    // 后端按 UUID 收下无横线等写法，应用内部只认规范写法：侧栏高亮、标题、草稿和 query key
    // 都以对话 id 为键，放第二种拼写进来同一段对话会裂成两份。解析不了的原样放行，走 404。
    const canonical = canonicalUuid(params.conversationId)
    if (canonical !== null && canonical !== params.conversationId) {
      throw redirect({ params: { conversationId: canonical }, search, to: '/c/$conversationId' })
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
