import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/shared/api/client'
import { zGenerationsPageOut } from '@/shared/api/generated/zod.gen'
import type { GenerationJob } from '../storyboard.api'
import { groupConversationVideos } from './video-groups'

const PAGE_LIMIT = 100

/** 完整读取后再投影，避免第一页全是在途或失败记录时漏掉更早的成片。 */
const readConversationVideos = async (conversationId: string, signal: AbortSignal) => {
  const items: GenerationJob[] = []
  const params = new URLSearchParams({ conversationId, kind: 'video', limit: `${PAGE_LIMIT}` })
  let before: string | undefined

  while (true) {
    if (before !== undefined) params.set('before', before)
    const page = await apiFetch(`/generations?${params}`, zGenerationsPageOut, {
      fallbackErrorMessage: '读取视频失败',
      signal,
    })
    items.push(...page.items)
    if (page.items.length < PAGE_LIMIT) return items
    const last = page.items.at(-1)
    if (last === undefined || last.id === before) throw new Error('视频记录分页异常，请重试')
    before = last.id
  }
}

export const useConversationVideos = (conversationId: string) =>
  useQuery({
    queryKey: ['generations', 'conversation-videos', conversationId],
    queryFn: ({ signal }) => readConversationVideos(conversationId, signal),
    select: groupConversationVideos,
    staleTime: 0,
    // 面板挂载期间持续发现新产物；关闭面板、卸载组件后由 Query 停止轮询。
    refetchInterval: 5000,
  })
