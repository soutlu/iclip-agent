import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { apiFetch } from '@/shared/api/client'
import { zCollectionEnvelope, zCollectionsPageOut } from '@/shared/api/generated/zod.gen'

// 删除返回 204，没有正文可校验
const noContentSchema = z.unknown()

const collectionEnvelopeSchema = zCollectionEnvelope.transform((payload) => payload.collection)
const collectionsPageSchema = zCollectionsPageOut.transform((payload) => payload.items)

// 请求后端允许的最大合集数。
const LIST_LIMIT = 100

const collectionsQueryKeys = {
  all: ['collections'] as const,
  list: () => ['collections', 'list'] as const,
}

/** 仅查询当前用户的合集，按最近修改排序。 */
export const useCollections = (enabled: boolean) =>
  useQuery({
    enabled,
    queryFn: () =>
      apiFetch(`/collections?limit=${LIST_LIMIT}`, collectionsPageSchema, {
        cache: 'no-store',
        fallbackErrorMessage: '读取合集失败',
      }),
    queryKey: collectionsQueryKeys.list(),
  })

export const useSaveCollection = (onSaved: () => void) => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ collectionId, name }: { collectionId?: string | undefined; name: string }) =>
      apiFetch(
        collectionId ? `/collections/${collectionId}` : '/collections',
        collectionEnvelopeSchema,
        {
          body: { name },
          fallbackErrorMessage: collectionId ? '重命名合集失败' : '新建合集失败',
          method: collectionId ? 'PATCH' : 'POST',
        },
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: collectionsQueryKeys.all })
      onSaved()
    },
  })
}

/** 删除合集仅解除分组，不删除其中的对话。 */
export const useDeleteCollection = (onSaved: () => void) => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (collectionId: string) =>
      apiFetch(`/collections/${collectionId}`, noContentSchema, {
        fallbackErrorMessage: '删除合集失败',
        method: 'DELETE',
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: collectionsQueryKeys.all })
      onSaved()
    },
  })
}
