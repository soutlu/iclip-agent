import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import { conversationsQueryKeys } from '@/features/conversations'
import { workspaceQueryKeys } from './workspace.api'

const CONVERSATION_ID = 'ff2c1c0e-6c4f-4f0e-9a2b-0f2f3a4b5c6d'

const seed = () => {
  const queryClient = new QueryClient()
  queryClient.setQueryData(workspaceQueryKeys.files(CONVERSATION_ID), { files: [] })
  queryClient.setQueryData(workspaceQueryKeys.file(CONVERSATION_ID, 'video_shot.json'), {})
  queryClient.setQueryData(conversationsQueryKeys.sidebar('all'), {})
  return queryClient
}

describe('workspaceQueryKeys', () => {
  it('不在会话键底下：会话侧整体失效碰不到工作区的文件列表与内容', async () => {
    const queryClient = seed()

    await queryClient.invalidateQueries({ queryKey: conversationsQueryKeys.all })

    expect(
      queryClient.getQueriesData({ queryKey: conversationsQueryKeys.all }).map(([key]) => key),
    ).toEqual([conversationsQueryKeys.sidebar('all')])
    expect(
      queryClient.getQueryState(workspaceQueryKeys.files(CONVERSATION_ID))?.isInvalidated,
    ).toBe(false)
  })

  it('all 前缀盖住这段对话的文件列表与每份文件，别的对话不动', async () => {
    const queryClient = seed()
    const other = 'a4b5c6d7-1111-4f0e-9a2b-0f2f3a4b5c6d'
    queryClient.setQueryData(workspaceQueryKeys.files(other), { files: [] })

    await queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.all(CONVERSATION_ID) })

    const invalidated = (key: readonly unknown[]) => queryClient.getQueryState(key)?.isInvalidated
    expect(invalidated(workspaceQueryKeys.files(CONVERSATION_ID))).toBe(true)
    expect(invalidated(workspaceQueryKeys.file(CONVERSATION_ID, 'video_shot.json'))).toBe(true)
    expect(invalidated(workspaceQueryKeys.files(other))).toBe(false)
    expect(invalidated(conversationsQueryKeys.sidebar('all'))).toBe(false)
  })
})
