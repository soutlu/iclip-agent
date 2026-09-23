import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/shared/api/client'
import { zGenerationsPageOut } from '@/shared/api/generated/zod.gen'
import { drainPages } from '@/shared/api/paging'
import { generationsRefetchInterval, type GenerationJob } from '../storyboard.api'
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

export const conversationVideosQueryKey = (conversationId: string) =>
  ['generations', 'conversation-videos', conversationId] as const

export const useConversationVideos = (conversationId: string) =>
  useQuery({
    queryKey: conversationVideosQueryKey(conversationId),
    queryFn: ({ signal }) => readConversationVideos(conversationId, signal),
    select: groupConversationVideos,
    // 生成帧到了由 useLiveGenerations 立刻失效；有在途任务时每 5 秒轮询兜底，全部结束后停。
    refetchInterval: ({ state }) => generationsRefetchInterval(state.data ?? []),
  })
