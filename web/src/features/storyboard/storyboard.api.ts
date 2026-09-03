/**
 * 分镜工作台要读的第二样东西：这段对话的生成任务。文件那一份走 `shared/workbench`。
 */

import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/shared/api/client'
import { zGenerationsPageOut } from '@/shared/api/generated/zod.gen'

/** 一段对话的镜头组不会有几百组，一次拿够，免得翻页把旧的那几条漏掉。 */
const PAGE_LIMIT = 100

export const storyboardQueryKeys = {
  generations: (conversationId: string) => ['generations', { conversationId }] as const,
}

/** 这段对话名下的生成任务，面板按 `shotIndex` 分组用。 */
export const useShotGenerations = (conversationId: string) =>
  useQuery({
    queryFn: ({ signal }) =>
      apiFetch(
        `/generations?conversationId=${conversationId}&limit=${PAGE_LIMIT}`,
        zGenerationsPageOut,
        { fallbackErrorMessage: '读取生成任务失败', signal },
      ),
    queryKey: storyboardQueryKeys.generations(conversationId),
  })
