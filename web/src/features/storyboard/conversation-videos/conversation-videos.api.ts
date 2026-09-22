import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/shared/api/client'
import { zGenerationsPageOut } from '@/shared/api/generated/zod.gen'
import { drainPages } from '@/shared/api/paging'
import type { GenerationJob } from '../storyboard.api'
import { groupConversationVideos } from './video-groups'

const PAGE_LIMIT = 100

/** 完整读取后再投影，避免第一页全是在途或失败记录时漏掉更早的成片。 */
const readConversationVideos = (conversationId: string, signal: AbortSignal) =>
  drainPages<GenerationJob, string>(async (before) => {
    const params = new URLSearchParams({ conversationId, kind: 'video', limit: `${PAGE_LIMIT}` })
    if (before !== undefined) params.set('before', before)
    const page = await apiFetch(`/generations?${params}`, zGenerationsPageOut, {
      fallbackErrorMessage: '读取视频失败',
      signal,
    })
    if (page.items.length < PAGE_LIMIT) return { items: page.items, next: null }
    const last = page.items.at(-1)
    // 游标没往前走就说明分页坏了，再翻下去是死循环。
    if (last === undefined || last.id === before) throw new Error('视频记录分页异常，请重试')
    return { items: page.items, next: last.id }
  })

export const useConversationVideos = (conversationId: string) =>
  useQuery({
    queryKey: ['generations', 'conversation-videos', conversationId],
    queryFn: ({ signal }) => readConversationVideos(conversationId, signal),
    select: groupConversationVideos,
    staleTime: 0,
    // 这条键没人按生成帧失效，轮询是发现新产物的唯一途径，不能改成有在途任务才轮询。
    // 面板挂载期间持续发现新产物；关闭面板、卸载组件后由 Query 停止轮询。
    refetchInterval: 5000,
  })
